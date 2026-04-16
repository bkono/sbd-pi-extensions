import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BeadworkAdapter } from "./bw.js";
import { buildWorkerHandoff } from "./handoff.js";
import { defaultProcessRunner, type ProcessRunner, shellQuote, sleep } from "./process.js";
import {
  loadWorkerRegistry,
  resolveWorkerRegistryPath,
  resolveWorkerRuntimeDir,
  saveWorkerRegistry,
  summarizeWorkers,
  upsertWorkerRuntime,
} from "./registry.js";
import { createTmuxBackend, type TmuxBackend, type TmuxPaneInspection } from "./tmux.js";
import type { BeadworkConfig, RunOptions, RunSummary, RunUntil, WorkerRuntime } from "./types.js";
import {
  cleanupTicketWorktree,
  type LandingVerificationResult,
  landWorktreeBranch,
  prepareTicketWorktree,
  rebaseWorktreeOntoRepoHead,
  runWorktreeValidation,
  verifyWorktreeLanding,
} from "./worktree.js";

function buildWorkerId(ticketId: string): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${ticketId.toLowerCase()}-${stamp}-${random}`;
}

function humanizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasPiPrintFlag(command: string): boolean {
  return /(^|\s)(?:--print|-p)(?=\s|$)/.test(command);
}

function hasPiModeFlag(command: string): boolean {
  return /(^|\s)--mode(?:=|\s+)[^\s]+/.test(command);
}

function shouldForcePiPrintMode(command: string): boolean {
  const [executable = ""] = command.trim().split(/\s+/, 1);
  return executable === "pi" || executable.endsWith("/pi");
}

export function buildWorkerAgentCommand(config: BeadworkConfig): string {
  const baseCommand = config.tmux.workerCommand.trim();
  let normalizedCommand = baseCommand;

  if (shouldForcePiPrintMode(baseCommand)) {
    if (!hasPiPrintFlag(normalizedCommand)) {
      normalizedCommand = `${normalizedCommand} --print`;
    }
    if (!hasPiModeFlag(normalizedCommand)) {
      normalizedCommand = `${normalizedCommand} --mode json`;
    }
  }

  const parts = [normalizedCommand];
  if (config.tmux.workerProvider?.trim()) {
    parts.push(`--provider ${shellQuote(config.tmux.workerProvider.trim())}`);
  }
  if (config.tmux.workerModel?.trim()) {
    parts.push(`--model ${shellQuote(config.tmux.workerModel.trim())}`);
  }
  return parts.filter((part) => part.length > 0).join(" ");
}

function buildWorkerScript(input: {
  workerAgentCommand: string;
  promptFile: string;
  logFile: string;
  stateFile: string;
  exitCodeFile: string;
  finishedAtFile: string;
}): string {
  return `#!/usr/bin/env bash
set -uo pipefail
exec > >(tee -a ${shellQuote(input.logFile)}) 2>&1
printf '[beadwork worker] started %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
printf '[beadwork worker] cwd: %s\n' "$PWD"
printf '[beadwork worker] handoff: %s\n' ${shellQuote(input.promptFile)}
printf '[beadwork worker] command: %s\n' ${shellQuote(input.workerAgentCommand)}
printf 'running\n' > ${shellQuote(input.stateFile)}
${input.workerAgentCommand} "$(cat ${shellQuote(input.promptFile)})"
status=$?
printf '%s\n' "$status" > ${shellQuote(input.exitCodeFile)}
date -u +"%Y-%m-%dT%H:%M:%SZ" > ${shellQuote(input.finishedAtFile)}
if [[ "$status" -eq 0 ]]; then
  printf 'exited\n' > ${shellQuote(input.stateFile)}
else
  printf 'failed\n' > ${shellQuote(input.stateFile)}
fi
printf '[beadwork worker] finished %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
printf '[beadwork worker exited with code %s]\n' "$status"
exit "$status"
`;
}

async function appendWorkerLog(logFile: string, message: string): Promise<void> {
  try {
    await appendFile(
      logFile,
      `[beadwork orchestrator] ${new Date().toISOString()} ${message}\n`,
      "utf8",
    );
  } catch {
    // best-effort runtime logging only
  }
}

export type WorkerLifecycleEvent = {
  type: "post-exit-started";
  ticketId: string;
  message: string;
};

async function cleanupLandedWorker(input: {
  repoRoot: string;
  worker: WorkerRuntime;
  tmuxBackend: TmuxBackend;
  runner: ProcessRunner;
}): Promise<Pick<WorkerRuntime, "cleanupStatus" | "cleanupAt" | "lastError">> {
  try {
    await input.tmuxBackend.cleanupWorker({
      paneId: input.worker.tmuxPane !== "pending" ? input.worker.tmuxPane : undefined,
      sessionName: input.worker.tmuxSession,
      windowName: input.worker.tmuxWindow,
    });
    await cleanupTicketWorktree({
      repoRoot: input.repoRoot,
      worktreePath: input.worker.worktreePath,
      runner: input.runner,
    });
    return {
      cleanupStatus: "cleaned",
      cleanupAt: new Date().toISOString(),
      lastError: undefined,
    };
  } catch (error) {
    return {
      cleanupStatus: "failed",
      cleanupAt: undefined,
      lastError: `Landing verified, but cleanup failed: ${humanizeError(error)}`,
    };
  }
}

function buildAttentionState(
  worker: WorkerRuntime,
  detail: string,
  overrides: Partial<WorkerRuntime> = {},
): WorkerRuntime {
  return {
    ...worker,
    ...overrides,
    status: "attention",
    landingVerification: overrides.landingVerification ?? detail,
    lastError: detail,
    updatedAt: new Date().toISOString(),
  };
}

async function autoLandCompletedWorker(input: {
  repoRoot: string;
  worker: WorkerRuntime;
  config: BeadworkConfig;
  tmuxBackend: TmuxBackend;
  runner: ProcessRunner;
  onLifecycleEvent?: (event: WorkerLifecycleEvent) => Promise<void> | void;
}): Promise<WorkerRuntime> {
  const attempts = Math.max(1, input.config.landing.maxRebaseAttempts);
  const validationRequired = input.config.landing.validateCommands.length > 0;
  let worker = {
    ...input.worker,
    validationStatus: validationRequired ? (input.worker.validationStatus ?? "pending") : undefined,
  };

  if (input.worker.status !== "attention" && input.worker.status !== "landed") {
    await appendWorkerLog(
      worker.logFile,
      `starting post-worker validation and landing checks for ${worker.ticketId}`,
    );
    await input.onLifecycleEvent?.({
      type: "post-exit-started",
      ticketId: worker.ticketId,
      message: `Delegated ticket ${worker.ticketId} exited. Starting validation and merge-back checks.`,
    });
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let landing: LandingVerificationResult;
    try {
      await appendWorkerLog(
        worker.logFile,
        `checking landing state (attempt ${attempt}/${attempts})`,
      );
      landing = await verifyWorktreeLanding({
        repoRoot: input.repoRoot,
        worktreePath: input.worker.worktreePath,
        ticketClosed: true,
        runner: input.runner,
      });
    } catch (error) {
      return buildAttentionState(worker, `Landing verification failed: ${humanizeError(error)}`, {
        validationStatus: worker.validationStatus,
        validationAt: worker.validationAt,
        validationSummary: worker.validationSummary,
      });
    }

    worker = {
      ...worker,
      landingVerification: landing.detail,
      landingAheadCount: landing.aheadCount,
      landingBehindCount: landing.behindCount,
      updatedAt: new Date().toISOString(),
    };

    if (landing.worktreeClean === false) {
      return buildAttentionState(worker, landing.detail);
    }

    if ((landing.aheadCount ?? 0) > 0 && (landing.behindCount ?? 0) > 0) {
      await appendWorkerLog(
        worker.logFile,
        "repo head moved; attempting to rebase worker worktree",
      );
      const rebase = await rebaseWorktreeOntoRepoHead({
        repoRoot: input.repoRoot,
        worktreePath: input.worker.worktreePath,
        runner: input.runner,
      });

      worker = {
        ...worker,
        landingVerification: rebase.detail,
        landingAheadCount: rebase.aheadCount,
        landingBehindCount: rebase.behindCount,
        updatedAt: new Date().toISOString(),
      };

      if (!rebase.rebased) {
        return buildAttentionState(worker, rebase.detail);
      }
    }

    if (validationRequired) {
      await appendWorkerLog(
        worker.logFile,
        "running configured validation commands before landing",
      );
      const validation = await runWorktreeValidation({
        worktreePath: input.worker.worktreePath,
        commands: input.config.landing.validateCommands,
        timeoutMs: input.config.landing.commandTimeoutMs,
        runner: input.runner,
      });

      worker = {
        ...worker,
        validationStatus: validation.passed ? "passed" : "failed",
        validationAt: validation.checkedAt,
        validationSummary: validation.detail,
        updatedAt: new Date().toISOString(),
      };

      await appendWorkerLog(
        worker.logFile,
        validation.passed ? "validation passed" : `validation failed: ${validation.detail}`,
      );

      if (!validation.passed) {
        return buildAttentionState(worker, validation.detail, {
          landingVerification: `Landing blocked after validation failure. ${validation.detail}`,
        });
      }
    }

    if (landing.verified) {
      await appendWorkerLog(
        worker.logFile,
        "worker changes are already integrated into the repo branch",
      );
      const landedWorker: WorkerRuntime = {
        ...worker,
        status: "landed",
        landingVerifiedAt: landing.checkedAt,
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      };

      if (
        landedWorker.cleanupPolicy === "cleanup-after-landing" &&
        landedWorker.cleanupStatus !== "cleaned"
      ) {
        await appendWorkerLog(
          worker.logFile,
          "cleanup-after-landing is enabled; cleaning up tmux session and worktree",
        );
        const cleanup = await cleanupLandedWorker({
          repoRoot: input.repoRoot,
          worker: landedWorker,
          tmuxBackend: input.tmuxBackend,
          runner: input.runner,
        });
        return {
          ...landedWorker,
          cleanupStatus: cleanup.cleanupStatus,
          cleanupAt: cleanup.cleanupAt,
          lastError: cleanup.lastError,
          updatedAt: new Date().toISOString(),
        };
      }

      return landedWorker;
    }

    if ((landing.aheadCount ?? 0) === 0) {
      return buildAttentionState(worker, landing.detail);
    }

    await appendWorkerLog(worker.logFile, "landing worker branch back into the repo branch");
    const landed = await landWorktreeBranch({
      repoRoot: input.repoRoot,
      worktreePath: input.worker.worktreePath,
      runner: input.runner,
    });

    worker = {
      ...worker,
      landingVerification: landed.detail,
      updatedAt: new Date().toISOString(),
    };

    if (!landed.landed) {
      if (attempt < attempts) {
        continue;
      }
      return buildAttentionState(worker, landed.detail);
    }

    await appendWorkerLog(worker.logFile, "verifying merge-back containment after landing");
    const verifiedAfterLanding = await verifyWorktreeLanding({
      repoRoot: input.repoRoot,
      worktreePath: input.worker.worktreePath,
      ticketClosed: true,
      runner: input.runner,
    });

    worker = {
      ...worker,
      landingVerification: verifiedAfterLanding.detail,
      landingAheadCount: verifiedAfterLanding.aheadCount,
      landingBehindCount: verifiedAfterLanding.behindCount,
      updatedAt: new Date().toISOString(),
    };

    if (verifiedAfterLanding.verified) {
      const landedWorker: WorkerRuntime = {
        ...worker,
        status: "landed",
        landingVerifiedAt: verifiedAfterLanding.checkedAt,
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      };

      if (
        landedWorker.cleanupPolicy === "cleanup-after-landing" &&
        landedWorker.cleanupStatus !== "cleaned"
      ) {
        await appendWorkerLog(
          worker.logFile,
          "cleanup-after-landing is enabled; cleaning up tmux session and worktree",
        );
        const cleanup = await cleanupLandedWorker({
          repoRoot: input.repoRoot,
          worker: landedWorker,
          tmuxBackend: input.tmuxBackend,
          runner: input.runner,
        });
        return {
          ...landedWorker,
          cleanupStatus: cleanup.cleanupStatus,
          cleanupAt: cleanup.cleanupAt,
          lastError: cleanup.lastError,
          updatedAt: new Date().toISOString(),
        };
      }

      return landedWorker;
    }

    if (attempt < attempts) {
      continue;
    }

    return buildAttentionState(worker, verifiedAfterLanding.detail);
  }

  return buildAttentionState(
    worker,
    `Landing could not be completed after ${attempts} attempt(s).`,
  );
}

export function buildRunOptions(
  config: BeadworkConfig,
  options: {
    workers?: number;
    until?: string;
    dryRun?: boolean;
    maxCycles?: number;
    noSpawn?: boolean;
  },
): RunOptions {
  const until: RunUntil =
    options.until === "empty" || options.until === "blocked"
      ? options.until
      : config.run.defaultUntil;
  return {
    workers:
      typeof options.workers === "number" && options.workers > 0
        ? options.workers
        : config.run.defaultWorkers,
    until,
    dryRun: options.dryRun === true,
    maxCycles:
      typeof options.maxCycles === "number" && options.maxCycles > 0
        ? options.maxCycles
        : config.run.defaultMaxCycles,
    pollIntervalMs: config.run.pollIntervalMs,
    noSpawn: options.noSpawn === true,
  };
}

export async function launchTicketWorker(input: {
  cwd: string;
  repoRoot: string;
  config: BeadworkConfig;
  adapter: BeadworkAdapter;
  ticketId: string;
  epicId?: string;
  prime?: string;
  tmuxBackend?: TmuxBackend;
}): Promise<WorkerRuntime> {
  const tmuxBackend = input.tmuxBackend ?? createTmuxBackend();
  const ticket = await input.adapter.show(input.cwd, input.ticketId);
  if (ticket.type === "epic") {
    throw new Error(`Cannot launch a worker directly for epic ${ticket.id}. Use /bw run instead.`);
  }

  const epic = ticket.parentId ? await input.adapter.show(input.cwd, ticket.parentId) : undefined;
  const prepared = await prepareTicketWorktree({
    repoRoot: input.repoRoot,
    ticketId: ticket.id,
    title: ticket.title,
    baseDir: input.config.worktrees.baseDir,
    copyFiles: input.config.worktrees.copyFiles,
    setupCommands: input.config.worktrees.setupCommands,
    rerunSetupOnReuse: input.config.worktrees.rerunSetupOnReuse,
  });

  const registryPath = resolveWorkerRegistryPath(
    input.repoRoot,
    input.config.storage.workerRegistryFile,
  );
  const runtimeRoot = resolveWorkerRuntimeDir(input.repoRoot, input.config.storage.runtimeDir);
  const workerId = buildWorkerId(ticket.id);
  const runtimeDir = path.join(runtimeRoot, workerId);
  await mkdir(runtimeDir, { recursive: true });

  const prompt = buildWorkerHandoff({
    ticket,
    epic,
    branchName: prepared.branchName,
    worktreePath: prepared.worktreePath,
    prime: input.prime,
  });

  const promptFile = path.join(runtimeDir, "handoff.txt");
  const logFile = path.join(runtimeDir, "worker.log");
  const stateFile = path.join(runtimeDir, "state.txt");
  const exitCodeFile = path.join(runtimeDir, "exit-code.txt");
  const finishedAtFile = path.join(runtimeDir, "finished-at.txt");
  const scriptFile = path.join(runtimeDir, "launch.sh");
  const workerAgentCommand = buildWorkerAgentCommand(input.config);

  await writeFile(promptFile, `${prompt}\n`, "utf8");
  await writeFile(
    scriptFile,
    buildWorkerScript({
      workerAgentCommand,
      promptFile,
      logFile,
      stateFile,
      exitCodeFile,
      finishedAtFile,
    }),
    "utf8",
  );
  await chmod(scriptFile, 0o755);

  const now = new Date().toISOString();
  const launchCommand = `bash ${shellQuote(scriptFile)}`;
  const pendingWorker: WorkerRuntime = {
    workerId,
    ticketId: ticket.id,
    epicId: input.epicId ?? ticket.parentId,
    ticketTitle: ticket.title,
    ticketStatus: ticket.status,
    branchName: prepared.branchName,
    worktreePath: prepared.worktreePath,
    backend: "tmux",
    tmuxSession: input.config.tmux.sessionName,
    tmuxWindow: workerId,
    tmuxPane: "pending",
    runtimeDir,
    promptFile,
    scriptFile,
    logFile,
    stateFile,
    exitCodeFile,
    finishedAtFile,
    launchCommand,
    workerCommand: input.config.tmux.workerCommand,
    workerProvider: input.config.tmux.workerProvider,
    workerModel: input.config.tmux.workerModel,
    cleanupPolicy: input.config.worktrees.cleanup,
    cleanupStatus:
      input.config.worktrees.cleanup === "cleanup-after-landing" ? "pending" : undefined,
    status: "launching",
    startedAt: now,
    updatedAt: now,
  };

  await upsertWorkerRuntime(registryPath, pendingWorker);
  await tmuxBackend.ensureSession({ sessionName: input.config.tmux.sessionName });
  const launched = await tmuxBackend.launchWorker({
    sessionName: input.config.tmux.sessionName,
    workerId,
    title: ticket.title,
    worktreePath: prepared.worktreePath,
    launchCommand,
  });

  const runningWorker: WorkerRuntime = {
    ...pendingWorker,
    tmuxSession: launched.sessionName,
    tmuxWindow: launched.windowName,
    tmuxPane: launched.paneId,
    launchCommand: launched.launchCommand,
    status: "running",
    updatedAt: new Date().toISOString(),
  };

  await upsertWorkerRuntime(registryPath, runningWorker);
  return runningWorker;
}

export async function inspectWorkerRuntime(input: {
  cwd: string;
  repoRoot: string;
  worker: WorkerRuntime;
  adapter: BeadworkAdapter;
  config?: BeadworkConfig;
  tmuxBackend?: TmuxBackend;
  runner?: ProcessRunner;
  onLifecycleEvent?: (event: WorkerLifecycleEvent) => Promise<void> | void;
}): Promise<WorkerRuntime> {
  const tmuxBackend = input.tmuxBackend ?? createTmuxBackend();
  const runner = input.runner ?? defaultProcessRunner;
  const config = input.config;
  const validationRequired = (config?.landing.validateCommands.length ?? 0) > 0;

  if (
    input.worker.status === "landed" &&
    input.worker.landingVerifiedAt &&
    (!validationRequired || input.worker.validationStatus === "passed")
  ) {
    return {
      ...input.worker,
      updatedAt: new Date().toISOString(),
    };
  }

  const [stateText, exitCodeText, finishedAtText, pane] = await Promise.all([
    readOptionalFile(input.worker.stateFile),
    readOptionalFile(input.worker.exitCodeFile),
    readOptionalFile(input.worker.finishedAtFile),
    input.worker.tmuxPane === "pending"
      ? Promise.resolve<TmuxPaneInspection>({ exists: false })
      : tmuxBackend.inspectWorker({
          paneId: input.worker.tmuxPane,
          sessionName: input.worker.tmuxSession,
          windowName: input.worker.tmuxWindow,
        }),
  ]);

  const resolvedTmuxSession =
    pane.exists && pane.sessionName ? pane.sessionName : input.worker.tmuxSession;
  const resolvedTmuxWindow =
    pane.exists && pane.windowName ? pane.windowName : input.worker.tmuxWindow;
  const resolvedTmuxPane = pane.exists && pane.paneId ? pane.paneId : input.worker.tmuxPane;
  const exitCode = parseInteger(exitCodeText);
  let nextStatus = input.worker.status;
  let ticketStatus = input.worker.ticketStatus;

  try {
    ticketStatus = (await input.adapter.show(input.cwd, input.worker.ticketId)).status;
  } catch {
    ticketStatus = input.worker.ticketStatus;
  }

  const workerFinished =
    stateText === "exited" ||
    stateText === "failed" ||
    (!pane.exists && input.worker.status !== "launching") ||
    input.worker.status === "exited" ||
    input.worker.status === "failed" ||
    input.worker.status === "attention" ||
    input.worker.status === "landed";

  if (ticketStatus === "closed" && workerFinished && config) {
    const orchestrated = await autoLandCompletedWorker({
      repoRoot: input.repoRoot,
      worker: {
        ...input.worker,
        ticketStatus,
        tmuxSession: resolvedTmuxSession,
        tmuxWindow: resolvedTmuxWindow,
        tmuxPane: resolvedTmuxPane,
        finishedAt: finishedAtText ?? input.worker.finishedAt,
      },
      config,
      tmuxBackend,
      runner,
      onLifecycleEvent: input.onLifecycleEvent,
    });

    return {
      ...orchestrated,
      ticketStatus,
      tmuxSession: resolvedTmuxSession,
      tmuxWindow: resolvedTmuxWindow,
      tmuxPane: resolvedTmuxPane,
      finishedAt: finishedAtText ?? orchestrated.finishedAt,
      updatedAt: new Date().toISOString(),
    };
  }

  if (stateText === "failed" || (exitCode !== undefined && exitCode !== 0)) {
    nextStatus = "failed";
  } else if (stateText === "exited" || (!pane.exists && input.worker.status !== "launching")) {
    nextStatus = "exited";
  } else if (stateText === "running" || (pane.exists && pane.dead !== true)) {
    nextStatus = "running";
  }

  const lastError =
    ticketStatus === "closed" && nextStatus === "exited"
      ? (input.worker.landingVerification ?? input.worker.lastError)
      : nextStatus === "failed" && ticketStatus !== "closed"
        ? (input.worker.lastError ??
          (exitCode !== undefined && exitCode !== 0
            ? `Worker exited with code ${exitCode}.`
            : "Worker exited before landing orchestration could begin."))
        : undefined;

  return {
    ...input.worker,
    ticketStatus,
    tmuxSession: resolvedTmuxSession,
    tmuxWindow: resolvedTmuxWindow,
    tmuxPane: resolvedTmuxPane,
    status: nextStatus,
    finishedAt: finishedAtText ?? input.worker.finishedAt,
    lastError,
    updatedAt: new Date().toISOString(),
  };
}

export async function listWorkers(input: {
  repoRoot: string;
  config: BeadworkConfig;
  epicId?: string;
}): Promise<WorkerRuntime[]> {
  const registryPath = resolveWorkerRegistryPath(
    input.repoRoot,
    input.config.storage.workerRegistryFile,
  );
  const workers = await loadWorkerRegistry(registryPath);
  return input.epicId ? workers.filter((worker) => worker.epicId === input.epicId) : workers;
}

export async function stopWorkers(input: {
  repoRoot: string;
  config: BeadworkConfig;
  workerIds?: string[];
  epicId?: string;
  tmuxBackend?: TmuxBackend;
  reason?: string;
}): Promise<WorkerRuntime[]> {
  const tmuxBackend = input.tmuxBackend ?? createTmuxBackend();
  const registryPath = resolveWorkerRegistryPath(
    input.repoRoot,
    input.config.storage.workerRegistryFile,
  );
  const workers = await loadWorkerRegistry(registryPath);
  const selectedIds = input.workerIds ? new Set(input.workerIds) : undefined;
  const now = new Date().toISOString();
  const stopped: WorkerRuntime[] = [];

  const nextWorkers = await Promise.all(
    workers.map(async (worker) => {
      const inScope = input.epicId ? worker.epicId === input.epicId : true;
      const selected = selectedIds ? selectedIds.has(worker.workerId) : true;
      const active = worker.status === "launching" || worker.status === "running";
      if (!inScope || !selected || !active) {
        return worker;
      }

      let nextWorker: WorkerRuntime = {
        ...worker,
        status: "exited",
        finishedAt: worker.finishedAt ?? now,
        updatedAt: now,
        lastError: input.reason ?? "Stopped by user.",
      };

      try {
        await tmuxBackend.cleanupWorker({
          paneId: worker.tmuxPane !== "pending" ? worker.tmuxPane : undefined,
          sessionName: worker.tmuxSession,
          windowName: worker.tmuxWindow,
        });
      } catch (error) {
        nextWorker = {
          ...nextWorker,
          status: "failed",
          lastError: `Failed to stop worker: ${humanizeError(error)}`,
        };
      }

      stopped.push(nextWorker);
      return nextWorker;
    }),
  );

  await saveWorkerRegistry(registryPath, nextWorkers);
  return stopped;
}

export async function runBoundedEpicLoop(input: {
  cwd: string;
  repoRoot: string;
  config: BeadworkConfig;
  adapter: BeadworkAdapter;
  epicId: string;
  options: RunOptions;
  prime?: string;
  tmuxBackend?: TmuxBackend;
  sleepFn?: (ms: number) => Promise<void>;
  runner?: ProcessRunner;
}): Promise<RunSummary> {
  const tmuxBackend = input.tmuxBackend ?? createTmuxBackend();
  const sleepFn = input.sleepFn ?? sleep;
  const runner = input.runner ?? defaultProcessRunner;
  const registryPath = resolveWorkerRegistryPath(
    input.repoRoot,
    input.config.storage.workerRegistryFile,
  );
  const launched = new Set<string>();
  const notes: string[] = [];
  const cycleSummaries: RunSummary["cycleSummaries"] = [];
  let stopReason: RunSummary["stopReason"] = "max-cycles";

  for (let cycle = 1; cycle <= input.options.maxCycles; cycle += 1) {
    const epic = await input.adapter.show(input.cwd, input.epicId);
    let workers = (await loadWorkerRegistry(registryPath)).filter(
      (worker) => worker.epicId === input.epicId,
    );

    const inspectedWorkers = await Promise.all(
      workers.map((worker) =>
        inspectWorkerRuntime({
          cwd: input.cwd,
          repoRoot: input.repoRoot,
          worker,
          adapter: input.adapter,
          config: input.config,
          tmuxBackend,
          runner,
        }),
      ),
    );

    workers = await saveWorkerRegistry(registryPath, [
      ...(await loadWorkerRegistry(registryPath)).filter(
        (worker) => worker.epicId !== input.epicId,
      ),
      ...inspectedWorkers,
    ]);
    workers = workers.filter((worker) => worker.epicId === input.epicId);

    const ready = await input.adapter.ready(input.cwd, input.epicId);
    const attemptedTicketIds = new Set(workers.map((worker) => worker.ticketId));
    const activeWorkers = workers.filter(
      (worker) => worker.status === "launching" || worker.status === "running",
    );
    const launchable = ready.filter(
      (issue) => !attemptedTicketIds.has(issue.id) && issue.type !== "epic",
    );
    const launchedThisCycle: string[] = [];

    if (!input.options.dryRun && !input.options.noSpawn) {
      const availableSlots = Math.max(0, input.options.workers - activeWorkers.length);
      for (const issue of launchable.slice(0, availableSlots)) {
        const worker = await launchTicketWorker({
          cwd: input.cwd,
          repoRoot: input.repoRoot,
          config: input.config,
          adapter: input.adapter,
          ticketId: issue.id,
          epicId: input.epicId,
          prime: input.prime,
          tmuxBackend,
        });
        launched.add(worker.ticketId);
        launchedThisCycle.push(worker.ticketId);
        workers.push(worker);
      }
    } else if (launchable.length > 0) {
      notes.push(
        `Cycle ${cycle}: ${launchable
          .slice(0, input.options.workers)
          .map((issue) => issue.id)
          .join(", ")} would be launched.`,
      );
    }

    const summary = summarizeWorkers(workers);
    cycleSummaries.push({
      cycle,
      ready: ready.map((issue) => issue.id),
      launched: launchedThisCycle,
      running: workers
        .filter((worker) => worker.status === "launching" || worker.status === "running")
        .map((worker) => worker.ticketId),
      landed: workers
        .filter((worker) => worker.status === "landed")
        .map((worker) => worker.ticketId),
      failed: workers
        .filter((worker) => worker.status === "failed")
        .map((worker) => worker.ticketId),
      attention: workers
        .filter((worker) => worker.status === "attention")
        .map((worker) => worker.ticketId),
      exited: workers
        .filter((worker) => worker.status === "exited")
        .map((worker) => worker.ticketId),
    });

    if (epic.status === "closed" || epic.children.every((child) => child.status === "closed")) {
      stopReason = "completed";
      break;
    }

    if (
      summary.failed > 0 ||
      summary.attention > 0 ||
      workers.some((worker) => worker.status === "exited")
    ) {
      notes.push(
        "At least one worker needs operator attention before the orchestrator can continue.",
      );
      stopReason = "attention";
      break;
    }

    if (ready.length === 0 && summary.active === 0) {
      stopReason = input.options.until === "empty" ? "empty" : "blocked";
      break;
    }

    if (launchable.length === 0 && summary.active === 0 && ready.length > 0) {
      notes.push("Ready tickets remain, but all have already been attempted in this run.");
      stopReason = "attention";
      break;
    }

    if (cycle < input.options.maxCycles && input.options.pollIntervalMs > 0) {
      await sleepFn(input.options.pollIntervalMs);
    }
  }

  const finalWorkers = (await loadWorkerRegistry(registryPath)).filter(
    (worker) => worker.epicId === input.epicId,
  );

  return {
    epicId: input.epicId,
    stopReason,
    cycles: cycleSummaries.length,
    launched: [...launched],
    activeWorkerIds: finalWorkers
      .filter((worker) => worker.status === "launching" || worker.status === "running")
      .map((worker) => worker.workerId),
    workerSummary: summarizeWorkers(finalWorkers),
    notes,
    cycleSummaries,
  };
}
