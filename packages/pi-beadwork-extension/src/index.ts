import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { handleCleanupAction } from "./actions/cleanup.js";
import { handleDelegateAction } from "./actions/delegate.js";
import { handleIssuesAction } from "./actions/issues.js";
import { handleLandingAction } from "./actions/landing.js";
import { handleRunAction } from "./actions/run.js";
import { handleScopeAction } from "./actions/scope.js";
import { handleStatusAction } from "./actions/status.js";
import { handleWorkersAction } from "./actions/workers.js";
import { detectActivation } from "./activation.js";
import { parseArgv, parseModelOverride } from "./argv.js";
import { createBeadworkAdapter } from "./bw.js";
import { registerBeadworkCommandAliases } from "./command-aliases.js";
import { createBeadworkCommandCompletionFactory } from "./command-completions.js";
import { showAdoptionPreview, showAdoptionResult, showStatus } from "./commands.js";
import { loadConfig } from "./config.js";
import { COMMAND_NAME, DEFAULT_SESSION_STATE } from "./constants.js";
import {
  inspectWorkerRuntime,
  launchTicketWorker,
  listWorkers,
  requestWorkerLanding,
  runBoundedEpicLoop,
  type WorkerLifecycleEvent,
} from "./orchestrator.js";
import {
  applyAdoptionPlan,
  buildAdoptionDecompositionPrompt,
  buildAdoptionPlan,
  formatAdoptionPreview,
  parseLandMode,
  resolvePlanSource,
} from "./plan-adoption.js";
import { buildBeadworkPromptAppendix } from "./prompt.js";
import {
  loadWorkerRegistry,
  resolveWorkerRegistryPath,
  summarizeWorkers,
  upsertWorkerRuntime,
} from "./registry.js";
import {
  loadSessionState,
  resetSessionState,
  resolveSessionStateDir,
  saveSessionState,
} from "./session-state.js";
import { updateStatusline } from "./statusline.js";
import type {
  ActivationState,
  BeadworkConfig,
  BeadworkCounts,
  BeadworkIssueDetail,
  BeadworkListFilters,
  BeadworkUpdateIssueInput,
  RunSummary,
  SessionRunOptions,
  SessionScope,
  SessionState,
  WorkerRuntime,
  WorkerSummary,
} from "./types.js";
import { inspectWorker } from "./worker-diagnostics.js";

export { loadConfig } from "./config.js";
export type {
  ActivationState,
  AdoptionApplyResult,
  AdoptionDependency,
  AdoptionInputStep,
  AdoptionLandMode,
  AdoptionOptions,
  AdoptionPlan,
  AdoptionStep,
  BeadworkConfig,
  BeadworkCounts,
  BeadworkHistoryEntry,
  BeadworkIssue,
  BeadworkIssueDetail,
  BeadworkListFilters,
  BeadworkUpdateIssueInput,
  LandingPolicy,
  RunOptions,
  RunSummary,
  SessionMode,
  SessionRunOptions,
  SessionScope,
  SessionState,
  WorkerRuntime,
  WorkerSummary,
  WorktreeCopyRule,
} from "./types.js";

function buildDefaultSessionState(): SessionState {
  return {
    ...DEFAULT_SESSION_STATE,
    updatedAt: new Date().toISOString(),
  };
}

function stalePrimeForRepo(state: SessionState, repoRoot: string | undefined): boolean {
  return Boolean(state.prime?.repoRoot && repoRoot && state.prime.repoRoot !== repoRoot);
}

function humanizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

function readStringOption(options: Map<string, string | true>, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === "string" ? value : undefined;
}

function readNumberOption(options: Map<string, string | true>, key: string): number | undefined {
  const value = readStringOption(options, key);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric value for --${key}: ${value}`);
  }

  return parsed;
}

function _buildListFilters(options: Map<string, string | true>): BeadworkListFilters {
  return {
    status: readStringOption(options, "status"),
    type: readStringOption(options, "type"),
    parent: readStringOption(options, "parent"),
    priority: readNumberOption(options, "priority"),
    assignee: readStringOption(options, "assignee"),
    grep: readStringOption(options, "grep"),
    limit: readNumberOption(options, "limit"),
    all: options.has("all"),
    deferred: options.has("deferred"),
    overdue: options.has("overdue"),
  };
}

function _buildUpdateInput(options: Map<string, string | true>): BeadworkUpdateIssueInput {
  const clearParent = options.has("clear-parent");
  const clearDue = options.has("clear-due");

  return {
    title: readStringOption(options, "title"),
    description: readStringOption(options, "description"),
    priority: readNumberOption(options, "priority"),
    assignee: readStringOption(options, "assignee"),
    type: readStringOption(options, "type"),
    status: readStringOption(options, "status"),
    parentId: clearParent ? null : readStringOption(options, "parent"),
    deferUntil: readStringOption(options, "defer"),
    dueAt: clearDue ? null : readStringOption(options, "due"),
  };
}

function hasIssueUpdate(input: BeadworkUpdateIssueInput): boolean {
  return (
    input.title !== undefined ||
    input.description !== undefined ||
    input.priority !== undefined ||
    input.assignee !== undefined ||
    input.type !== undefined ||
    input.status !== undefined ||
    input.parentId !== undefined ||
    input.deferUntil !== undefined ||
    input.dueAt !== undefined
  );
}

function _normalizeDependencyPair(args: string[]): { blockerId: string; blockedId: string } | null {
  if (args.length < 2) {
    return null;
  }

  const [first, second, third] = args;
  if (second === "blocks") {
    if (!first || !third) {
      return null;
    }
    return { blockerId: first, blockedId: third };
  }

  if (!first || !second) {
    return null;
  }

  return { blockerId: first, blockedId: second };
}

function sameStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  const normalizedLeft = [...(left ?? [])].sort();
  const normalizedRight = [...(right ?? [])].sort();
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedLeft.every((entry, index) => entry === normalizedRight[index]);
}

function sameNoticeMap(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  const rightEntries = Object.entries(right ?? {}).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );

  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(
    ([leftKey, leftValue], index) =>
      leftKey === rightEntries[index]?.[0] && leftValue === rightEntries[index]?.[1],
  );
}

function shouldSuperviseInBackground(activation: ActivationState, state: SessionState): boolean {
  if (activation.kind !== "active" || !activation.repoRoot) {
    return false;
  }

  if (
    state.mode === "run" &&
    state.scope.kind === "epic" &&
    state.runOptions &&
    state.runOptions.dryRun !== true
  ) {
    return true;
  }

  return Boolean(state.trackedWorkerIds && state.trackedWorkerIds.length > 0);
}

function buildRunSupervisorNotice(
  summary: RunSummary,
): { level: "info" | "warning"; message: string } | undefined {
  if (summary.stopReason === "completed") {
    return {
      level: "info",
      message: `Background /bw run finished for ${summary.epicId}: all scoped work is closed.`,
    };
  }

  if (summary.stopReason === "empty" || summary.stopReason === "blocked") {
    return {
      level: "info",
      message: `Background /bw run paused for ${summary.epicId}: no additional scoped ready work is available right now.`,
    };
  }

  if (summary.stopReason === "attention") {
    return {
      level: "warning",
      message: `Background /bw run paused for ${summary.epicId}: operator attention is required before more tickets can be launched.`,
    };
  }

  return undefined;
}

function buildSupervisorRunSummary(state: SessionState, config: BeadworkConfig): SessionRunOptions {
  const persisted = state.runOptions ?? state.lastRunOptions;
  return {
    workers:
      persisted?.workers && persisted.workers > 0 ? persisted.workers : config.run.defaultWorkers,
    until: persisted?.until ?? config.run.defaultUntil,
    noSpawn: persisted?.noSpawn === true,
    dryRun: false,
    maxCycles:
      persisted?.maxCycles && persisted.maxCycles > 0
        ? persisted.maxCycles
        : config.run.defaultMaxCycles,
  };
}

function buildLifecycleEventNotice(event: WorkerLifecycleEvent): {
  level: "info" | "warning";
  message: string;
} {
  switch (event.type) {
    case "post-exit-started":
    case "remediation-started":
      return { level: "info", message: event.message };
  }
}

function buildWorkerNotice(input: {
  worker: WorkerRuntime;
  inspection: ReturnType<typeof inspectWorker>;
}): { key: string; level: "info" | "warning"; message: string } | undefined {
  const { worker, inspection } = input;
  const key = [
    worker.status,
    worker.ticketStatus ?? "",
    inspection.validation.state,
    inspection.review.state,
    inspection.landing.state,
    inspection.cleanup.state,
    worker.validationSummary ?? "",
    worker.reviewSummary ?? "",
    worker.landingVerification ?? "",
    worker.lastError ?? "",
  ].join("|");

  if (
    worker.landingRequestedAt &&
    !worker.landingVerifiedAt &&
    (inspection.validation.state === "pending" ||
      inspection.review.state === "pending" ||
      worker.ticketStatus !== "closed")
  ) {
    const reviewLogFile = path.join(worker.runtimeDir, "review.log");
    const detail =
      inspection.review.state === "pending"
        ? ` Follow reviewer output in ${reviewLogFile}.`
        : inspection.validation.state === "pending"
          ? ` Follow orchestrator progress in ${worker.logFile}.`
          : "";
    return {
      key,
      level: "info",
      message:
        `Delegated ticket ${worker.ticketId} has an explicit landing request in flight. ${inspection.followUp.action}${detail}`.trim(),
    };
  }

  if (worker.status === "running" && worker.remediationStatus === "running") {
    return {
      key,
      level: "info",
      message:
        `Delegated ticket ${worker.ticketId} failed validation, and an automatic remediation pass is now running in the existing worktree. ` +
        `Follow streamed worker activity in ${worker.logFile}.`,
    };
  }

  if (worker.status === "running" && worker.reviewStatus === "remediation-in-progress") {
    return {
      key,
      level: "info",
      message:
        `Delegated ticket ${worker.ticketId} is remediating reviewer-requested changes before merge-back. ` +
        `Follow streamed worker activity in ${worker.logFile}.`,
    };
  }

  if (worker.status === "running" && worker.ticketStatus === "closed") {
    return {
      key,
      level: "info",
      message: `Delegated ticket ${worker.ticketId} was closed in the worker and is waiting for process exit so landing can be verified.`,
    };
  }

  if (worker.status === "failed") {
    return {
      key,
      level: "warning",
      message: `Delegated ticket ${worker.ticketId} failed. ${inspection.followUp.action}`,
    };
  }

  if (worker.status === "attention") {
    return {
      key,
      level: "warning",
      message: `Delegated ticket ${worker.ticketId} needs attention. ${inspection.followUp.action}`,
    };
  }

  if (worker.status === "exited") {
    if (worker.ticketStatus !== "closed") {
      return {
        key,
        level: "warning",
        message: `Delegated ticket ${worker.ticketId} exited before the ticket was closed. ${inspection.followUp.action}`,
      };
    }

    const detail = inspection.landing.detail ? ` ${inspection.landing.detail}` : "";
    return {
      key,
      level: "warning",
      message:
        `Delegated ticket ${worker.ticketId} finished, but landing still needs review. ${inspection.followUp.action}${detail}`.trim(),
    };
  }

  if (worker.status === "held") {
    if (inspection.landing.state === "ready-to-land") {
      const review =
        inspection.review.state === "approved"
          ? " Reviewer approved."
          : inspection.review.state === "nits-only"
            ? " Reviewer approved with non-blocking nits."
            : "";
      return {
        key,
        level: "info",
        message:
          `Delegated ticket ${worker.ticketId} is validated and held in deferred-landing mode.${review} ` +
          `It is ready to land when requested with /bw land ${worker.ticketId}.`,
      };
    }

    if (inspection.landing.state === "needs-refresh") {
      return {
        key,
        level: "warning",
        message:
          `Delegated ticket ${worker.ticketId} is validated and held, but repo drift means it needs refresh before merge-back. ` +
          inspection.followUp.action,
      };
    }

    return {
      key,
      level: "warning",
      message: `Delegated ticket ${worker.ticketId} is held and needs attention. ${inspection.followUp.action}`,
    };
  }

  if (worker.status === "landed") {
    if (inspection.validation.state === "pending") {
      return {
        key,
        level: "warning",
        message: `Delegated ticket ${worker.ticketId} appears integrated, but validation is still pending. ${inspection.followUp.action}`,
      };
    }

    if (inspection.validation.state === "failed") {
      return {
        key,
        level: "warning",
        message: `Delegated ticket ${worker.ticketId} appears integrated, but validation failed. ${inspection.followUp.action}`,
      };
    }

    if (inspection.cleanup.state === "cleaned") {
      return {
        key,
        level: "info",
        message:
          `Delegated ticket ${worker.ticketId} completed successfully: validation passed, ` +
          "changes were merged back into the repo branch, and cleanup completed.",
      };
    }

    if (inspection.cleanup.state === "failed") {
      return {
        key,
        level: "warning",
        message: `Delegated ticket ${worker.ticketId} landed, but cleanup failed. ${inspection.followUp.action}`,
      };
    }

    const validation =
      inspection.validation.state === "passed" ? " Validation passed before merge-back." : "";
    const review =
      inspection.review.state === "approved"
        ? " Reviewer approved the merge-back."
        : inspection.review.state === "nits-only"
          ? " Reviewer approved with non-blocking nits."
          : "";
    return {
      key,
      level: "info",
      message:
        `Delegated ticket ${worker.ticketId} completed successfully: changes were merged back into the repo branch.${validation}${review} ${inspection.followUp.action}`.trim(),
    };
  }

  return undefined;
}

export default function piBeadworkExtension(pi: ExtensionAPI): void {
  const adapter = createBeadworkAdapter();
  const stateCache = new Map<string, SessionState>();
  const backgroundSupervisors = new Map<
    string,
    { timer: ReturnType<typeof setInterval>; running: boolean }
  >();

  function getStateDir(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
  ): string {
    return resolveSessionStateDir(activation.repoRoot ?? ctx.cwd, config.storage.sessionStateDir);
  }

  async function readSessionState(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
  ): Promise<SessionState> {
    const sessionId = ctx.sessionManager.getSessionId();
    const cached = stateCache.get(sessionId);
    if (cached) {
      if (stalePrimeForRepo(cached, activation.repoRoot)) {
        const nextState = {
          ...cached,
          prime: undefined,
          updatedAt: new Date().toISOString(),
        };
        stateCache.set(sessionId, nextState);
        return nextState;
      }
      return cached;
    }

    try {
      const state = await loadSessionState(getStateDir(ctx, activation, config), sessionId);
      const normalized = stalePrimeForRepo(state, activation.repoRoot)
        ? { ...state, prime: undefined, updatedAt: new Date().toISOString() }
        : state;
      stateCache.set(sessionId, normalized);
      return normalized;
    } catch {
      const fallback = buildDefaultSessionState();
      stateCache.set(sessionId, fallback);
      return fallback;
    }
  }

  async function writeSessionState(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
  ): Promise<SessionState> {
    const sessionId = ctx.sessionManager.getSessionId();
    const normalized = {
      ...state,
      updatedAt: new Date().toISOString(),
    };

    stateCache.set(sessionId, normalized);

    let persisted = normalized;
    try {
      persisted = await saveSessionState(
        getStateDir(ctx, activation, config),
        sessionId,
        normalized,
      );
    } catch {
      persisted = normalized;
    }

    reconcileBackgroundSupervisor(ctx, activation, config, persisted);
    return persisted;
  }

  function stopBackgroundSupervisor(sessionId: string): void {
    const existing = backgroundSupervisors.get(sessionId);
    if (!existing) {
      return;
    }

    clearInterval(existing.timer);
    backgroundSupervisors.delete(sessionId);
  }

  function reconcileBackgroundSupervisor(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
  ): void {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!shouldSuperviseInBackground(activation, state)) {
      stopBackgroundSupervisor(sessionId);
      return;
    }

    if (backgroundSupervisors.has(sessionId)) {
      return;
    }

    const timer = setInterval(
      () => {
        void runBackgroundSupervisorTick(ctx);
      },
      Math.max(1_000, config.supervisor.pollIntervalMs),
    );
    backgroundSupervisors.set(sessionId, { timer, running: false });
  }

  async function runBackgroundSupervisorTick(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    const supervisor = backgroundSupervisors.get(sessionId);
    if (!supervisor || supervisor.running) {
      return;
    }

    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      return;
    }

    supervisor.running = true;

    try {
      const config = loadConfig(ctx.cwd);
      const activation = await detectActivation(ctx.cwd);
      let state = await readSessionState(ctx, activation, config);

      if (!shouldSuperviseInBackground(activation, state)) {
        stopBackgroundSupervisor(sessionId);
        return;
      }

      if (
        state.mode === "run" &&
        state.scope.kind === "epic" &&
        state.runOptions &&
        state.runOptions.dryRun !== true &&
        activation.kind === "active"
      ) {
        const summary = await runBoundedEpicLoop({
          cwd: ctx.cwd,
          repoRoot: activation.repoRoot ?? ctx.cwd,
          config,
          adapter,
          epicId: state.scope.id,
          options: {
            ...buildSupervisorRunSummary(state, config),
            maxCycles: 1,
            pollIntervalMs: 0,
          },
          prime: state.prime?.content,
        });

        const status = await refreshStatus(ctx);
        state = status.state;

        const runNotice = buildRunSupervisorNotice(summary);
        if (summary.stopReason !== "max-cycles") {
          const paused = await writeSessionState(ctx, activation, config, {
            ...state,
            mode: "interactive",
            runOptions: undefined,
            recentRunSummary: summary,
          });
          updateStatusline(
            ctx,
            activation,
            paused,
            config,
            status.workerSummary ?? summary.workerSummary,
          );
          if (runNotice) {
            ctx.ui.notify(runNotice.message, runNotice.level);
          }
          return;
        }

        const continued = await writeSessionState(ctx, activation, config, {
          ...state,
          recentRunSummary: summary,
        });
        updateStatusline(
          ctx,
          activation,
          continued,
          config,
          status.workerSummary ?? summary.workerSummary,
        );
        return;
      }

      await refreshStatus(ctx);
    } catch (error) {
      ctx.ui.notify(`Beadwork background supervision failed: ${humanizeError(error)}`, "warning");
    } finally {
      const current = backgroundSupervisors.get(sessionId);
      if (current) {
        current.running = false;
      }
    }
  }

  async function resolveScopeDetail(
    ctx: ExtensionContext,
    activation: ActivationState,
    state: SessionState,
  ): Promise<BeadworkIssueDetail | undefined> {
    if (activation.kind !== "active" || state.scope.kind === "none") {
      return undefined;
    }

    try {
      return await adapter.show(ctx.cwd, state.scope.id);
    } catch {
      return undefined;
    }
  }

  async function resolveCounts(
    ctx: ExtensionContext,
    activation: ActivationState,
    state: SessionState,
  ): Promise<BeadworkCounts | undefined> {
    if (activation.kind !== "active") {
      return undefined;
    }

    try {
      const scopeId = state.scope.kind === "none" ? undefined : state.scope.id;
      return await adapter.getCounts(ctx.cwd, scopeId);
    } catch {
      return undefined;
    }
  }

  async function ensurePrime(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    force = false,
  ): Promise<SessionState> {
    if (activation.kind !== "active") {
      return state;
    }

    if (!force && state.prime?.content && state.prime.repoRoot === activation.repoRoot) {
      return state;
    }

    const prime = await adapter.prime(ctx.cwd);
    return writeSessionState(ctx, activation, config, {
      ...state,
      prime: {
        content: prime,
        loadedAt: new Date().toISOString(),
        repoRoot: activation.repoRoot,
      },
    });
  }

  async function resolveWorkerSummary(
    activation: ActivationState,
    config: BeadworkConfig,
    epicId?: string,
  ): Promise<WorkerSummary | undefined> {
    if (activation.kind !== "active" || !activation.repoRoot) {
      return undefined;
    }

    const registryPath = resolveWorkerRegistryPath(
      activation.repoRoot,
      config.storage.workerRegistryFile,
    );
    const workers = await loadWorkerRegistry(registryPath);
    const scoped = epicId ? workers.filter((worker) => worker.epicId === epicId) : workers;
    return summarizeWorkers(scoped);
  }

  async function refreshStatus(ctx: ExtensionContext): Promise<{
    activation: ActivationState;
    state: SessionState;
    counts?: BeadworkCounts;
    scopeDetail?: BeadworkIssueDetail;
    workerSummary?: WorkerSummary;
    workers?: WorkerRuntime[];
  }> {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    let state = await readSessionState(ctx, activation, config);
    const scopedEpicId = state.scope.kind === "epic" ? state.scope.id : undefined;
    const trackedWorkerIds = state.trackedWorkerIds;
    const shouldInspectWorkers =
      activation.kind === "active" &&
      (state.mode !== "neutral" || (trackedWorkerIds !== undefined && trackedWorkerIds.length > 0));

    const [counts, scopeDetail] = await Promise.all([
      resolveCounts(ctx, activation, state),
      resolveScopeDetail(ctx, activation, state),
    ]);

    let workerSummary: WorkerSummary | undefined;
    let workers: WorkerRuntime[] | undefined;
    if (shouldInspectWorkers) {
      const inspectedWorkers = await inspectWorkers(ctx, activation, config, {
        epicId: scopedEpicId,
        workerIds: state.mode === "neutral" ? trackedWorkerIds : undefined,
      });
      state = await syncWorkerTracking(ctx, activation, config, state, inspectedWorkers);
      workerSummary = summarizeWorkers(inspectedWorkers);
    } else {
      workerSummary = await resolveWorkerSummary(activation, config, scopedEpicId);
    }

    if (activation.kind === "active" && activation.repoRoot) {
      workers = await loadWorkerRegistry(
        resolveWorkerRegistryPath(activation.repoRoot, config.storage.workerRegistryFile),
      );
    }

    updateStatusline(ctx, activation, state, config, workerSummary);

    return { activation, state, counts, scopeDetail, workerSummary, workers };
  }

  async function resetState(ctx: ExtensionCommandContext): Promise<SessionState> {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    const nextState = buildDefaultSessionState();

    stateCache.set(sessionId, nextState);

    try {
      const persisted = await resetSessionState(getStateDir(ctx, activation, config), sessionId);
      stateCache.set(sessionId, persisted);
      updateStatusline(ctx, activation, persisted, config);
      return persisted;
    } catch {
      updateStatusline(ctx, activation, nextState, config);
      return nextState;
    }
  }

  async function requireActive(ctx: ExtensionCommandContext): Promise<{
    activation: ActivationState;
    config: BeadworkConfig;
    state: SessionState;
  } | null> {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    const state = await readSessionState(ctx, activation, config);

    if (activation.kind !== "active") {
      await showStatus(ctx, { activation, state });
      ctx.ui.notify("Beadwork is not active in this repository.", "warning");
      return null;
    }

    return { activation, config, state };
  }

  async function setSessionMode(
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    mode: SessionState["mode"],
    scope?: SessionScope,
    runOptions?: SessionRunOptions,
  ): Promise<{ state: SessionState; scopeDetail?: BeadworkIssueDetail }> {
    const stateWithPrime = await ensurePrime(ctx, activation, config, state, false);
    const nextState = await writeSessionState(ctx, activation, config, {
      ...stateWithPrime,
      mode,
      engagedAt: new Date().toISOString(),
      scope: scope ?? state.scope,
      runOptions: mode === "run" ? (runOptions ?? state.runOptions) : undefined,
    });
    const scopeDetail = await resolveScopeDetail(ctx, activation, nextState);
    const workerSummary = await resolveWorkerSummary(
      activation,
      config,
      nextState.scope.kind === "epic" ? nextState.scope.id : undefined,
    );
    updateStatusline(ctx, activation, nextState, config, workerSummary);
    return { state: nextState, scopeDetail };
  }

  async function resolveScopeFromArg(
    ctx: ExtensionCommandContext,
    scopeId: string | undefined,
  ): Promise<SessionScope | undefined> {
    if (!scopeId) {
      return undefined;
    }

    const issue = await adapter.show(ctx.cwd, scopeId);
    return {
      kind: issue.type === "epic" ? "epic" : "ticket",
      id: issue.id,
      title: issue.title,
    };
  }

  function shouldKeepWorkerTracked(
    worker: WorkerRuntime,
    inspection: ReturnType<typeof inspectWorker>,
  ): boolean {
    if (
      worker.status === "launching" ||
      worker.status === "running" ||
      worker.status === "held" ||
      inspection.followUp.needsAttention
    ) {
      return true;
    }

    if (worker.landingRequestedAt && !worker.landingVerifiedAt) {
      return true;
    }

    return (
      worker.ticketStatus === "closed" &&
      worker.status === "exited" &&
      (worker.validationStatus === "pending" || worker.reviewStatus === "pending")
    );
  }

  async function trackWorkerForBackground(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    worker: WorkerRuntime,
  ): Promise<SessionState> {
    const trackedWorkerIds = [
      ...new Set([...(state.trackedWorkerIds ?? []), worker.workerId]),
    ].sort();
    const workerNotices = { ...(state.workerNotices ?? {}) };
    delete workerNotices[worker.workerId];

    const nextState = await writeSessionState(ctx, activation, config, {
      ...state,
      trackedWorkerIds,
      workerNotices: Object.keys(workerNotices).length > 0 ? workerNotices : undefined,
    });
    const workerSummary = await resolveWorkerSummary(
      activation,
      config,
      nextState.scope.kind === "epic" ? nextState.scope.id : undefined,
    );
    updateStatusline(ctx, activation, nextState, config, workerSummary);
    return nextState;
  }

  async function inspectWorkers(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
    options: {
      epicId?: string;
      workerIds?: string[];
    } = {},
  ): Promise<WorkerRuntime[]> {
    if (activation.kind !== "active" || !activation.repoRoot) {
      return [];
    }

    const selectedIds = options.workerIds ? new Set(options.workerIds) : undefined;
    const workers = (
      await listWorkers({
        repoRoot: activation.repoRoot,
        config,
        epicId: options.epicId,
      })
    ).filter((worker) => (selectedIds ? selectedIds.has(worker.workerId) : true));

    const registryPath = resolveWorkerRegistryPath(
      activation.repoRoot,
      config.storage.workerRegistryFile,
    );

    const inspected = await Promise.all(
      workers.map((worker) =>
        inspectWorkerRuntime({
          cwd: ctx.cwd,
          repoRoot: activation.repoRoot ?? ctx.cwd,
          worker,
          adapter,
          config,
          awaitOrchestration: false,
          onLifecycleEvent: (event) => {
            const notice = buildLifecycleEventNotice(event);
            ctx.ui.notify(notice.message, notice.level);
          },
          onWorkerUpdate: async (nextWorker) => {
            await upsertWorkerRuntime(registryPath, nextWorker);
          },
        }),
      ),
    );

    await Promise.all(inspected.map((worker) => upsertWorkerRuntime(registryPath, worker)));
    const latest = await loadWorkerRegistry(registryPath);
    const scoped = options.epicId
      ? latest.filter((worker) => worker.epicId === options.epicId)
      : latest;
    return selectedIds ? scoped.filter((worker) => selectedIds.has(worker.workerId)) : scoped;
  }

  async function syncWorkerTracking(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    workers: WorkerRuntime[],
  ): Promise<SessionState> {
    const previousNotices = state.workerNotices;
    const nextNotices: Record<string, string> = {};
    const nextTrackedWorkerIds: string[] = [];
    const notifications: Array<{ level: "info" | "warning"; message: string }> = [];

    const inspections = workers.map((worker) => {
      const inspection = inspectWorker(worker);
      const notice = buildWorkerNotice({ worker, inspection });
      const keepTracked = shouldKeepWorkerTracked(worker, inspection);
      return { worker, inspection, notice, keepTracked };
    });

    for (const entry of inspections) {
      if (entry.keepTracked) {
        nextTrackedWorkerIds.push(entry.worker.workerId);
      }

      if (!entry.notice) {
        continue;
      }

      nextNotices[entry.worker.workerId] = entry.notice.key;
      if (previousNotices?.[entry.worker.workerId] === entry.notice.key) {
        continue;
      }

      notifications.push({
        level: entry.notice.level,
        message: entry.notice.message,
      });
    }

    const normalizedTrackedWorkerIds =
      nextTrackedWorkerIds.length > 0 ? [...new Set(nextTrackedWorkerIds)].sort() : undefined;
    const normalizedNotices = Object.keys(nextNotices).length > 0 ? nextNotices : undefined;

    let nextState = state;
    if (
      !sameStringArray(state.trackedWorkerIds, normalizedTrackedWorkerIds) ||
      !sameNoticeMap(state.workerNotices, normalizedNotices)
    ) {
      nextState = await writeSessionState(ctx, activation, config, {
        ...state,
        trackedWorkerIds: normalizedTrackedWorkerIds,
        workerNotices: normalizedNotices,
      });
    }

    for (const notification of notifications) {
      ctx.ui.notify(notification.message, notification.level);
    }

    return nextState;
  }

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    const state = await readSessionState(ctx, activation, config);
    await writeSessionState(ctx, activation, config, state);
    const workerSummary = await resolveWorkerSummary(
      activation,
      config,
      state.scope.kind === "epic" ? state.scope.id : undefined,
    );
    updateStatusline(ctx, activation, state, config, workerSummary);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopBackgroundSupervisor(ctx.sessionManager.getSessionId());
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    let state = await readSessionState(ctx, activation, config);

    if (activation.kind !== "active" || state.mode === "neutral") {
      return undefined;
    }

    try {
      state = await ensurePrime(ctx, activation, config, state, false);
    } catch {
      // ignore prompt enrichment failures; interactive mode still works without cached prime
    }

    const scopeDetail = await resolveScopeDetail(ctx, activation, state);
    const appendix = buildBeadworkPromptAppendix({
      activation,
      sessionState: state,
      scopeDetail,
    });

    if (!appendix) {
      return undefined;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${appendix}`,
    };
  });

  const commandCompletions = createBeadworkCommandCompletionFactory({
    adapter,
    detectActivation,
    getCwd: () => process.cwd(),
    getWorkers: async () => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      const activation = await detectActivation(cwd);
      if (activation.kind !== "active" || !activation.repoRoot) {
        return [];
      }

      return loadWorkerRegistry(
        resolveWorkerRegistryPath(activation.repoRoot, config.storage.workerRegistryFile),
      );
    },
  });

  async function dispatchBeadworkCommand(
    subcommand: string,
    args: string,
    ctx: ExtensionCommandContext,
    options: { isBare?: boolean } = {},
  ): Promise<void> {
    const parsed = parseArgv(args);

    try {
      if (
        await handleStatusAction({
          subcommand,
          parsed,
          isBare: options.isBare === true,
          ctx,
          deps: {
            adapter,
            refreshStatus,
            requireActive,
            ensurePrime,
            setSessionMode,
            writeSessionState,
            resolveCounts,
            inspectWorkers,
            syncWorkerTracking,
            executeLand: async (actionCtx, target) => {
              await handleLandingAction({
                subcommand: "land",
                parsed: { positional: [target], options: new Map() },
                ctx: actionCtx,
                deps: {
                  adapter,
                  requireActive,
                  trackWorkerForBackground,
                },
              });
            },
            executeCancel: async (actionCtx, target) => {
              await handleWorkersAction({
                subcommand: "cancel",
                parsed: { positional: [target], options: new Map() },
                ctx: actionCtx,
                deps: {
                  requireActive,
                  inspectWorkers,
                  syncWorkerTracking,
                },
              });
            },
            executeCleanup: async (actionCtx, target) => {
              await handleCleanupAction({
                subcommand: "cleanup",
                parsed: { positional: [target], options: new Map() },
                ctx: actionCtx,
                deps: {
                  loadConfig,
                  detectActivation,
                  readSessionState,
                  resetState,
                  inspectWorkers,
                  requireActive,
                },
              });
            },
          },
        })
      ) {
        return;
      }

      if (
        await handleScopeAction({
          subcommand,
          parsed,
          ctx,
          deps: {
            requireActive,
            resolveScopeFromArg,
            setSessionMode,
            resolveCounts,
          },
        })
      ) {
        return;
      }

      if (
        await handleIssuesAction({
          subcommand,
          parsed,
          ctx,
          deps: {
            adapter,
            requireActive,
          },
        })
      ) {
        return;
      }

      if (
        await handleWorkersAction({
          subcommand,
          parsed,
          ctx,
          deps: {
            requireActive,
            inspectWorkers,
            syncWorkerTracking,
          },
        })
      ) {
        return;
      }

      if (
        await handleDelegateAction({
          subcommand,
          parsed,
          ctx,
          deps: {
            adapter,
            requireActive,
            ensurePrime,
            inspectWorkers,
            syncWorkerTracking,
          },
        })
      ) {
        return;
      }

      if (
        await handleLandingAction({
          subcommand,
          parsed,
          ctx,
          deps: {
            adapter,
            requireActive,
            trackWorkerForBackground,
          },
        })
      ) {
        return;
      }

      if (
        await handleCleanupAction({
          subcommand,
          parsed,
          ctx,
          deps: {
            loadConfig,
            detectActivation,
            readSessionState,
            resetState,
            inspectWorkers,
            requireActive,
          },
        })
      ) {
        return;
      }

      if (
        await handleRunAction({
          subcommand,
          parsed,
          ctx,
          deps: {
            adapter,
            requireActive,
            ensurePrime,
            setSessionMode,
            writeSessionState,
          },
        })
      ) {
        return;
      }

      if (subcommand === "adopt") {
        const landMode = parseLandMode(
          typeof parsed.options.get("land") === "string"
            ? String(parsed.options.get("land"))
            : undefined,
        );
        const title =
          typeof parsed.options.get("title") === "string"
            ? String(parsed.options.get("title"))
            : undefined;
        const planFile =
          typeof parsed.options.get("file") === "string"
            ? path.resolve(ctx.cwd, String(parsed.options.get("file")))
            : undefined;
        const apply = parsed.options.has("apply");
        const editorText = "getEditorText" in ctx.ui ? ctx.ui.getEditorText() : undefined;

        let fileText: string | undefined;
        if (planFile) {
          try {
            fileText = await readFile(planFile, "utf8");
          } catch (error) {
            throw new Error(`Failed to read plan file ${planFile}: ${humanizeError(error)}`);
          }
        }

        const source = resolvePlanSource({
          inlineText: parsed.positional.join(" "),
          editorText,
          file: planFile ? { path: planFile, markdown: fileText } : undefined,
        });

        if (!source) {
          ctx.ui.notify(
            planFile
              ? `No markdown content found in ${planFile}.`
              : "No explicit markdown plan source found. Pass markdown to /bw adopt, provide --file <path>, or keep the plan in the editor.",
            "warning",
          );
          return;
        }

        const plan = buildAdoptionPlan(source, { title, landMode });
        const preview = formatAdoptionPreview(plan);

        if (!apply) {
          await showAdoptionPreview(ctx, plan, preview);
          return;
        }

        if (plan.landMode === "quick") {
          await showAdoptionResult(ctx, [preview, "", "No beadwork mutation performed."]);
          return;
        }

        const active = await requireActive(ctx);
        if (!active) {
          return;
        }

        if (plan.landMode === "multi") {
          const decompositionPrompt = buildAdoptionDecompositionPrompt(plan);
          pi.sendUserMessage(decompositionPrompt);
          await showAdoptionResult(ctx, [
            preview,
            "",
            "Queued an LLM-guided decomposition turn.",
            "The model will materialize the graph via beadwork_create_issue and beadwork_add_dependency.",
            "Review the resulting epic/task graph, then run /bw status or /bw show <epic-id>.",
          ]);
          return;
        }

        const result = await applyAdoptionPlan(adapter, ctx.cwd, plan);
        const resultLines = [preview, "", "Created:"];
        for (const issue of result.created) {
          resultLines.push(`- ${issue.id} · ${issue.type} · ${issue.title}`);
        }
        if (result.root) {
          resultLines.push("", `Root issue: ${result.root.id}`);
          const rootScope: Exclude<SessionScope, { kind: "none" }> = {
            kind: result.root.type === "epic" ? "epic" : "ticket",
            id: result.root.id,
            title: result.root.title,
          };
          await setSessionMode(
            ctx,
            active.activation,
            active.config,
            active.state,
            "interactive",
            rootScope,
          );
          resultLines.push(`Session scope set to ${rootScope.kind}:${rootScope.id}`);
        }

        await showAdoptionResult(ctx, resultLines);
        return;
      }

      ctx.ui.notify(
        "Usage: /bw [status|engage [scope]|scope <issue-id|clear>|prime [--refresh]|ready [scope]|blocked|list [--all --status ... --type ... --parent ... --priority n --assignee ... --grep ... --limit n --deferred --overdue]|history <id> [--limit n]|show <id>|create <title> [--type ... --description ... --priority n --parent id]|update <id> [--title ... --description ... --priority n --assignee ... --status ... --type ... --parent id|--clear-parent --defer when --due when|--clear-due]|dep <add|remove> <blocker> [blocks] <blocked>|start <id>|close <id>|reopen <id>|comment <id> <text>|label <id> +label [-label]|defer <id> <when>|undefer <id>|sync|workers [epic-id]|delegate <ticket-id> [--model provider/model]|land <ticket-id|worker-id>|cancel <ticket-id|worker-id>|cleanup <ticket-id|worker-id>|run <epic-id> [--workers n] [--until blocked|empty] [--max-cycles n] [--dry-run] [--no-spawn]|adopt [markdown-plan] [--file path/to/plan.md] [--title ...] [--land quick|branch|multi] [--apply]|off [--stop-workers] [--all-workers] [--leave-workers]]",
        "info",
      );
    } catch (error) {
      ctx.ui.notify(humanizeError(error), "error");
    }
  }

  pi.registerCommand(COMMAND_NAME, {
    description: "Open the beadwork dashboard or run beadwork session/worker commands",
    getArgumentCompletions: (prefix) => commandCompletions.getMainCommandCompletions(prefix),
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        await dispatchBeadworkCommand("status", "", ctx, { isBare: true });
        return;
      }

      const firstSpace = trimmed.search(/\s/);
      const subcommand = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
      const remainder = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
      await dispatchBeadworkCommand(subcommand, remainder, ctx);
    },
  });

  registerBeadworkCommandAliases({
    pi,
    dispatch: (subcommand, args, ctx) => dispatchBeadworkCommand(subcommand, args, ctx),
    getAliasCompletions: (subcommand, prefix) =>
      commandCompletions.getAliasCommandCompletions(subcommand, prefix),
  });

  pi.registerTool({
    name: "beadwork_status",
    label: "Beadwork Status",
    description: "Show beadwork activation, mode, counts, and scope context.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const status = await refreshStatus(ctx);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        details: status,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_prime",
    label: "Beadwork Prime",
    description: "Return the cached or freshly loaded `bw prime` guidance.",
    parameters: Type.Object({
      refresh: Type.Optional(Type.Boolean({ description: "Force a fresh `bw prime` read." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const activation = await detectActivation(ctx.cwd);
      let state = await readSessionState(ctx, activation, config);

      if (activation.kind !== "active") {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ activation, state }, null, 2) },
          ],
          details: { activation, state },
        };
      }

      state = await ensurePrime(ctx, activation, config, state, params.refresh === true);
      return {
        content: [{ type: "text" as const, text: state.prime?.content ?? "" }],
        details: state.prime,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_ready",
    label: "Beadwork Ready",
    description: "List ready beadwork issues, optionally scoped to an issue subtree.",
    parameters: Type.Object({
      scope_id: Type.Optional(
        Type.String({ description: "Optional issue id to scope `bw ready` to a subtree." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ready = await adapter.ready(ctx.cwd, params.scope_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(ready, null, 2) }],
        details: ready,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_blocked",
    label: "Beadwork Blocked",
    description: "List currently blocked beadwork issues.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const blocked = await adapter.blocked(ctx.cwd);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(blocked, null, 2) }],
        details: blocked,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_list_issues",
    label: "Beadwork List Issues",
    description: "List beadwork issues with explicit filters.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by status." })),
      type: Type.Optional(Type.String({ description: "Filter by type." })),
      parent_id: Type.Optional(Type.String({ description: "Filter by parent issue id." })),
      priority: Type.Optional(Type.Number({ description: "Filter by priority number." })),
      assignee: Type.Optional(Type.String({ description: "Filter by assignee." })),
      grep: Type.Optional(Type.String({ description: "Search title/description text." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of issues." })),
      all: Type.Optional(Type.Boolean({ description: "Include all statuses." })),
      deferred: Type.Optional(Type.Boolean({ description: "Only deferred issues." })),
      overdue: Type.Optional(Type.Boolean({ description: "Only overdue issues." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issues = await adapter.list(ctx.cwd, {
        status: params.status,
        type: params.type,
        parent: params.parent_id,
        priority: params.priority,
        assignee: params.assignee,
        grep: params.grep,
        limit: params.limit,
        all: params.all,
        deferred: params.deferred,
        overdue: params.overdue,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issues, null, 2) }],
        details: issues,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_issue_history",
    label: "Beadwork Issue History",
    description: "Read beadwork git history entries for one issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to inspect." }),
      limit: Type.Optional(Type.Number({ description: "Maximum history entries." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const history = await adapter.history(ctx.cwd, params.id, params.limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(history, null, 2) }],
        details: history,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_show",
    label: "Beadwork Show",
    description: "Show one beadwork issue including children.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to inspect." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.show(ctx.cwd, params.id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_create_issue",
    label: "Beadwork Create Issue",
    description: "Create a beadwork issue or epic.",
    parameters: Type.Object({
      title: Type.String({ description: "Issue title." }),
      description: Type.Optional(Type.String({ description: "Issue description." })),
      type: Type.Optional(Type.String({ description: "Issue type, e.g. task or epic." })),
      priority: Type.Optional(Type.Number({ description: "Priority number 0-4." })),
      parent_id: Type.Optional(Type.String({ description: "Optional parent epic id." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const created = await adapter.createIssue(ctx.cwd, {
        title: params.title,
        description: params.description,
        type: params.type,
        priority: params.priority,
        parentId: params.parent_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(created.issue, null, 2) }],
        details: created.issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_update_issue",
    label: "Beadwork Update Issue",
    description: "Update mutable fields on an existing beadwork issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to update." }),
      title: Type.Optional(Type.String({ description: "New title." })),
      description: Type.Optional(Type.String({ description: "New description." })),
      priority: Type.Optional(Type.Number({ description: "Priority number 0-4." })),
      assignee: Type.Optional(Type.String({ description: "New assignee." })),
      type: Type.Optional(Type.String({ description: "New issue type." })),
      status: Type.Optional(Type.String({ description: "New status." })),
      parent_id: Type.Optional(Type.String({ description: "New parent issue id." })),
      clear_parent: Type.Optional(Type.Boolean({ description: "Clear parent relationship." })),
      defer_until: Type.Optional(Type.String({ description: "Set defer date expression." })),
      due_at: Type.Optional(Type.String({ description: "Set due date expression." })),
      clear_due: Type.Optional(Type.Boolean({ description: "Clear due date." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const updateInput: BeadworkUpdateIssueInput = {
        title: params.title,
        description: params.description,
        priority: params.priority,
        assignee: params.assignee,
        type: params.type,
        status: params.status,
        parentId: params.clear_parent ? null : params.parent_id,
        deferUntil: params.defer_until,
        dueAt: params.clear_due ? null : params.due_at,
      };

      if (!hasIssueUpdate(updateInput)) {
        throw new Error("No update fields provided.");
      }

      const issue = await adapter.updateIssue(ctx.cwd, params.id, updateInput);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_add_dependency",
    label: "Beadwork Add Dependency",
    description: "Add a beadwork dependency edge: blocker blocks blocked.",
    parameters: Type.Object({
      blocker_id: Type.String({ description: "Blocking issue id." }),
      blocked_id: Type.String({ description: "Blocked issue id." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await adapter.addDependency(ctx.cwd, params.blocker_id, params.blocked_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                blocker_id: params.blocker_id,
                blocked_id: params.blocked_id,
                ok: true,
              },
              null,
              2,
            ),
          },
        ],
        details: { blockerId: params.blocker_id, blockedId: params.blocked_id },
      };
    },
  });

  pi.registerTool({
    name: "beadwork_remove_dependency",
    label: "Beadwork Remove Dependency",
    description: "Remove a beadwork dependency edge: blocker blocks blocked.",
    parameters: Type.Object({
      blocker_id: Type.String({ description: "Blocking issue id." }),
      blocked_id: Type.String({ description: "Blocked issue id." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await adapter.removeDependency(ctx.cwd, params.blocker_id, params.blocked_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                blocker_id: params.blocker_id,
                blocked_id: params.blocked_id,
                ok: true,
              },
              null,
              2,
            ),
          },
        ],
        details: { blockerId: params.blocker_id, blockedId: params.blocked_id },
      };
    },
  });

  pi.registerTool({
    name: "beadwork_start_issue",
    label: "Beadwork Start Issue",
    description: "Run `bw start` for one issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to start." }),
      assignee: Type.Optional(Type.String({ description: "Optional assignee override." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.start(ctx.cwd, params.id, params.assignee);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_close_issue",
    label: "Beadwork Close Issue",
    description: "Run `bw close` for one issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to close." }),
      reason: Type.Optional(Type.String({ description: "Optional close reason." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.close(ctx.cwd, params.id, params.reason);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_reopen_issue",
    label: "Beadwork Reopen Issue",
    description: "Reopen a beadwork issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to reopen." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.reopen(ctx.cwd, params.id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_comment_issue",
    label: "Beadwork Comment Issue",
    description: "Add a comment to a beadwork issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to comment on." }),
      text: Type.String({ description: "Comment text." }),
      author: Type.Optional(Type.String({ description: "Optional comment author." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.comment(ctx.cwd, params.id, params.text, params.author);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_label_issue",
    label: "Beadwork Label Issue",
    description: "Apply label add/remove operations to a beadwork issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to label." }),
      operations: Type.String({
        description: "Comma-separated label operations, e.g. +bug,-triage",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const operations = params.operations
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (operations.length === 0) {
        throw new Error("At least one label operation is required.");
      }

      const issue = await adapter.label(ctx.cwd, params.id, operations);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_defer_issue",
    label: "Beadwork Defer Issue",
    description: "Defer a beadwork issue until a date expression.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to defer." }),
      when: Type.String({ description: "Date expression, e.g. tomorrow or 2026-04-20." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.defer(ctx.cwd, params.id, params.when);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_undefer_issue",
    label: "Beadwork Undefer Issue",
    description: "Restore a deferred beadwork issue back to open.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to undefer." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.undefer(ctx.cwd, params.id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_delegate",
    label: "Beadwork Delegate",
    description: "Launch a tmux-backed beadwork worker for one existing ticket.",
    parameters: Type.Object({
      ticket_id: Type.String({ description: "Ticket id to launch in a worktree." }),
      epic_id: Type.Optional(Type.String({ description: "Optional parent epic id." })),
      model: Type.Optional(
        Type.String({
          description: "Optional one-off worker model override. Supports provider/model.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const activation = await detectActivation(ctx.cwd);
      const state = await readSessionState(ctx, activation, config);
      if (activation.kind !== "active") {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ activation, state }, null, 2) },
          ],
          details: { activation, state },
        };
      }
      const modelOverride = params.model ? parseModelOverride(params.model) : undefined;
      const primedState = await ensurePrime(ctx, activation, config, state, false);
      const worker = await launchTicketWorker({
        cwd: ctx.cwd,
        repoRoot: activation.repoRoot ?? ctx.cwd,
        config,
        adapter,
        ticketId: params.ticket_id,
        epicId: params.epic_id,
        prime: primedState.prime?.content,
        workerProviderOverride: modelOverride?.provider,
        workerModelOverride: modelOverride?.model,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(worker, null, 2) }],
        details: worker,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_land_worker",
    label: "Beadwork Land Worker",
    description:
      "Request explicit merge-back for a delegated worker that was held after validation.",
    parameters: Type.Object({
      ticket_id: Type.Optional(Type.String({ description: "Ticket id to land." })),
      worker_id: Type.Optional(Type.String({ description: "Worker id to land." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!params.ticket_id && !params.worker_id) {
        throw new Error("Provide either ticket_id or worker_id.");
      }

      const config = loadConfig(ctx.cwd);
      const activation = await detectActivation(ctx.cwd);
      if (activation.kind !== "active" || !activation.repoRoot) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "beadwork is not active" }, null, 2),
            },
          ],
          details: { error: "beadwork is not active" },
        };
      }

      const state = await readSessionState(ctx, activation, config);
      const worker = await requestWorkerLanding({
        cwd: ctx.cwd,
        repoRoot: activation.repoRoot,
        config,
        adapter,
        ticketId: params.ticket_id,
        workerId: params.worker_id,
      });
      await trackWorkerForBackground(ctx, activation, config, state, worker);
      const inspection = inspectWorker(worker);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ worker, inspection }, null, 2),
          },
        ],
        details: { worker, inspection },
      };
    },
  });

  pi.registerTool({
    name: "beadwork_worker_check",
    label: "Beadwork Worker Check",
    description: "Inspect beadwork worker runtime state from the local registry.",
    parameters: Type.Object({
      worker_id: Type.Optional(Type.String({ description: "Optional worker id to inspect." })),
      epic_id: Type.Optional(Type.String({ description: "Optional epic id to filter workers." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const activation = await detectActivation(ctx.cwd);
      if (activation.kind !== "active" || !activation.repoRoot) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify([], null, 2) }],
          details: [],
        };
      }

      const workers = await inspectWorkers(ctx, activation, config, {
        epicId: params.epic_id,
      });
      const filtered = params.worker_id
        ? workers.filter((worker) => worker.workerId === params.worker_id)
        : workers;
      const inspections = filtered.map((worker) => inspectWorker(worker));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(inspections, null, 2) }],
        details: inspections,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_sync",
    label: "Beadwork Sync",
    description: "Run `bw sync` in the current repository.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      await adapter.sync(ctx.cwd);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true }, null, 2) }],
        details: { ok: true },
      };
    },
  });
}
