import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { detectActivation } from "./activation.js";
import { parseArgv } from "./argv.js";
import { createBeadworkAdapter } from "./bw.js";
import {
  showAdoptionPreview,
  showAdoptionResult,
  showHistory,
  showIssue,
  showIssueList,
  showMutationResult,
  showPrime,
  showReady,
  showRunSummary,
  showStatus,
  showWorkers,
} from "./commands.js";
import { loadConfig } from "./config.js";
import { COMMAND_NAME, DEFAULT_SESSION_STATE } from "./constants.js";
import {
  buildRunOptions,
  inspectWorkerRuntime,
  launchTicketWorker,
  listWorkers,
  runBoundedEpicLoop,
  stopWorkers,
  type WorkerLifecycleEvent,
} from "./orchestrator.js";
import {
  applyAdoptionPlan,
  buildAdoptionPlan,
  formatAdoptionPreview,
  parseLandMode,
  resolvePlanSource,
} from "./plan-adoption.js";
import { buildBeadworkPromptAppendix } from "./prompt.js";
import {
  loadWorkerRegistry,
  resolveWorkerRegistryPath,
  saveWorkerRegistry,
  summarizeWorkers,
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

function buildListFilters(options: Map<string, string | true>): BeadworkListFilters {
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

function buildUpdateInput(options: Map<string, string | true>): BeadworkUpdateIssueInput {
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

function normalizeDependencyPair(args: string[]): { blockerId: string; blockedId: string } | null {
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
  const persisted = state.runOptions;
  return {
    workers:
      persisted?.workers && persisted.workers > 0 ? persisted.workers : config.run.defaultWorkers,
    until: persisted?.until ?? config.run.defaultUntil,
    noSpawn: persisted?.noSpawn === true,
    dryRun: false,
  };
}

function buildLifecycleEventNotice(event: WorkerLifecycleEvent): {
  level: "info" | "warning";
  message: string;
} {
  switch (event.type) {
    case "post-exit-started":
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
    inspection.landing.state,
    inspection.cleanup.state,
    worker.validationSummary ?? "",
    worker.landingVerification ?? "",
    worker.lastError ?? "",
  ].join("|");

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
    return {
      key,
      level: "info",
      message:
        `Delegated ticket ${worker.ticketId} completed successfully: changes were merged back into the repo branch.${validation} ${inspection.followUp.action}`.trim(),
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

        updateStatusline(
          ctx,
          activation,
          state,
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
    if (shouldInspectWorkers) {
      const workers = await inspectWorkers(ctx, activation, config, {
        epicId: scopedEpicId,
        workerIds: state.mode === "neutral" ? trackedWorkerIds : undefined,
      });
      state = await syncWorkerTracking(ctx, activation, config, state, workers);
      workerSummary = summarizeWorkers(workers);
    } else {
      workerSummary = await resolveWorkerSummary(activation, config, scopedEpicId);
    }

    updateStatusline(ctx, activation, state, config, workerSummary);

    return { activation, state, counts, scopeDetail, workerSummary };
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

    const inspected = await Promise.all(
      workers.map((worker) =>
        inspectWorkerRuntime({
          cwd: ctx.cwd,
          repoRoot: activation.repoRoot ?? ctx.cwd,
          worker,
          adapter,
          config,
          onLifecycleEvent: (event) => {
            const notice = buildLifecycleEventNotice(event);
            ctx.ui.notify(notice.message, notice.level);
          },
        }),
      ),
    );

    const registryPath = resolveWorkerRegistryPath(
      activation.repoRoot,
      config.storage.workerRegistryFile,
    );
    const existing = await loadWorkerRegistry(registryPath);
    const merged = [
      ...existing.filter(
        (worker) => !inspected.some((candidate) => candidate.workerId === worker.workerId),
      ),
      ...inspected,
    ];
    await saveWorkerRegistry(registryPath, merged);
    return options.epicId
      ? inspected.filter((worker) => worker.epicId === options.epicId)
      : inspected;
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
      const keepTracked =
        worker.status === "launching" ||
        worker.status === "running" ||
        inspection.followUp.needsAttention;
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

  pi.registerCommand(COMMAND_NAME, {
    description: "Beadwork session status, engagement, and ticket helpers",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommand = "status", ...restParts] =
        trimmed.length > 0 ? parseArgv(trimmed).positional : [];
      const remainder = trimmed.length > 0 ? trimmed.slice(subcommand.length).trim() : "";
      const parsed = parseArgv(remainder);

      try {
        if (subcommand === "status") {
          const status = await refreshStatus(ctx);
          await showStatus(ctx, status);
          return;
        }

        if (subcommand === "off") {
          const config = loadConfig(ctx.cwd);
          const activation = await detectActivation(ctx.cwd);
          const currentState = await readSessionState(ctx, activation, config);
          const stopWorkersRequested = parsed.options.has("stop-workers");
          const leaveWorkers = parsed.options.has("leave-workers");
          const stopAllWorkers = parsed.options.has("all-workers");

          const activeWorkers =
            activation.kind === "active" && activation.repoRoot
              ? (await inspectWorkers(ctx, activation, config)).filter(
                  (worker) => worker.status === "launching" || worker.status === "running",
                )
              : [];
          const scopedEpicId =
            !stopAllWorkers && currentState.scope.kind === "epic"
              ? currentState.scope.id
              : undefined;

          if (activeWorkers.length > 0 && !stopWorkersRequested && !leaveWorkers) {
            const stopHint = scopedEpicId
              ? `/bw off --stop-workers (current epic ${scopedEpicId})`
              : "/bw off --stop-workers";
            ctx.ui.notify(
              `Active beadwork workers are still running (${activeWorkers.length}). Run ${stopHint} to stop them first, or /bw off --leave-workers to reset this session and leave them running.`,
              "warning",
            );
            return;
          }

          if (stopWorkersRequested && activation.kind === "active" && activation.repoRoot) {
            const stopped = await stopWorkers({
              repoRoot: activation.repoRoot,
              config,
              epicId: scopedEpicId,
              reason: scopedEpicId
                ? `Stopped by /bw off for epic ${scopedEpicId}.`
                : "Stopped by /bw off.",
            });
            ctx.ui.notify(
              stopped.length > 0
                ? scopedEpicId
                  ? `Stopped ${stopped.length} beadwork worker(s) for epic ${scopedEpicId}.`
                  : `Stopped ${stopped.length} beadwork worker(s).`
                : scopedEpicId
                  ? `No active workers matched epic ${scopedEpicId}.`
                  : "No active beadwork workers were running.",
              "info",
            );
          }

          const state = await resetState(ctx);
          ctx.ui.notify(
            leaveWorkers && activeWorkers.length > 0
              ? "Beadwork session mode reset to neutral; active workers were left running."
              : "Beadwork session mode reset to neutral.",
            "info",
          );
          await showStatus(ctx, { activation, state });
          return;
        }

        if (subcommand === "engage") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const scopeArg = parsed.positional[0] ?? restParts[0];
          const scope = scopeArg
            ? ((await resolveScopeFromArg(ctx, scopeArg)) as
                | Exclude<SessionScope, { kind: "none" }>
                | undefined)
            : undefined;
          const { state, scopeDetail } = await setSessionMode(
            ctx,
            active.activation,
            active.config,
            active.state,
            "interactive",
            scope,
          );
          const counts = await resolveCounts(ctx, active.activation, state);
          ctx.ui.notify(
            scope
              ? `Beadwork interactive mode engaged for ${scope.kind} ${scope.id}.`
              : "Beadwork interactive mode engaged.",
            "info",
          );
          await showStatus(ctx, {
            activation: active.activation,
            state,
            counts,
            scopeDetail,
          });
          return;
        }

        if (subcommand === "prime") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const refresh = parsed.options.has("refresh");
          const state = await ensurePrime(
            ctx,
            active.activation,
            active.config,
            active.state,
            refresh,
          );
          await showPrime(ctx, state.prime?.content ?? "", state.prime?.loadedAt);
          return;
        }

        if (subcommand === "ready") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const scopeId =
            parsed.positional[0] ??
            (active.state.scope.kind === "none" ? undefined : active.state.scope.id);
          const ready = await adapter.ready(ctx.cwd, scopeId);
          await showReady(ctx, ready, scopeId);
          return;
        }

        if (subcommand === "blocked") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const blocked = await adapter.blocked(ctx.cwd);
          await showIssueList(ctx, blocked, "Blocked work:");
          return;
        }

        if (subcommand === "list") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const filters = buildListFilters(parsed.options);
          const issues = await adapter.list(ctx.cwd, filters);
          await showIssueList(ctx, issues, "Issue list:");
          return;
        }

        if (subcommand === "history") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId = parsed.positional[0];
          if (!issueId) {
            ctx.ui.notify("Usage: /bw history <issue-id> [--limit n]", "info");
            return;
          }

          const entries = await adapter.history(
            ctx.cwd,
            issueId,
            readNumberOption(parsed.options, "limit"),
          );
          await showHistory(ctx, issueId, entries);
          return;
        }

        if (subcommand === "show") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId =
            parsed.positional[0] ??
            (active.state.scope.kind === "none" ? undefined : active.state.scope.id);
          if (!issueId) {
            ctx.ui.notify("Usage: /bw show <issue-id>", "info");
            return;
          }

          const issue = await adapter.show(ctx.cwd, issueId);
          await showIssue(ctx, issue);
          return;
        }

        if (subcommand === "create") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const title = parsed.positional.join(" ").trim();
          if (!title) {
            ctx.ui.notify(
              "Usage: /bw create <title> [--type task|epic] [--description text] [--priority n] [--parent id]",
              "info",
            );
            return;
          }

          const created = await adapter.createIssue(ctx.cwd, {
            title,
            type: readStringOption(parsed.options, "type"),
            description: readStringOption(parsed.options, "description"),
            priority: readNumberOption(parsed.options, "priority"),
            parentId: readStringOption(parsed.options, "parent"),
          });
          await showMutationResult(ctx, "Created", created.issue);
          return;
        }

        if (subcommand === "update") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId = parsed.positional[0];
          if (!issueId) {
            ctx.ui.notify(
              "Usage: /bw update <issue-id> [--title text] [--description text] [--priority n] [--assignee name] [--status open|in_progress|closed|deferred] [--type task|epic] [--parent id|--clear-parent] [--defer when] [--due when|--clear-due]",
              "info",
            );
            return;
          }

          const updateInput = buildUpdateInput(parsed.options);
          if (!hasIssueUpdate(updateInput)) {
            ctx.ui.notify("No update fields supplied. Pass at least one --flag to mutate.", "info");
            return;
          }

          const issue = await adapter.updateIssue(ctx.cwd, issueId, updateInput);
          await showMutationResult(ctx, "Updated", issue);
          return;
        }

        if (subcommand === "dep") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const operation = parsed.positional[0];
          const pair = normalizeDependencyPair(parsed.positional.slice(1));
          if (!operation || !pair || (operation !== "add" && operation !== "remove")) {
            ctx.ui.notify("Usage: /bw dep <add|remove> <blocker-id> [blocks] <blocked-id>", "info");
            return;
          }

          if (operation === "add") {
            await adapter.addDependency(ctx.cwd, pair.blockerId, pair.blockedId);
            ctx.ui.notify(`Dependency added: ${pair.blockerId} blocks ${pair.blockedId}.`, "info");
            return;
          }

          await adapter.removeDependency(ctx.cwd, pair.blockerId, pair.blockedId);
          ctx.ui.notify(
            `Dependency removed: ${pair.blockerId} no longer blocks ${pair.blockedId}.`,
            "info",
          );
          return;
        }

        if (subcommand === "start") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId = parsed.positional[0];
          if (!issueId) {
            ctx.ui.notify("Usage: /bw start <issue-id> [--assignee name]", "info");
            return;
          }

          const assignee = readStringOption(parsed.options, "assignee");
          const issue = await adapter.start(ctx.cwd, issueId, assignee);
          await showMutationResult(ctx, "Started", issue);
          return;
        }

        if (subcommand === "close") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId = parsed.positional[0];
          if (!issueId) {
            ctx.ui.notify("Usage: /bw close <issue-id> [--reason text]", "info");
            return;
          }

          const reasonOption = parsed.options.get("reason");
          const reason = typeof reasonOption === "string" ? reasonOption : undefined;
          const issue = await adapter.close(ctx.cwd, issueId, reason);
          await showMutationResult(ctx, "Closed", issue);
          return;
        }

        if (subcommand === "reopen") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId = parsed.positional[0];
          if (!issueId) {
            ctx.ui.notify("Usage: /bw reopen <issue-id>", "info");
            return;
          }

          const issue = await adapter.reopen(ctx.cwd, issueId);
          await showMutationResult(ctx, "Reopened", issue);
          return;
        }

        if (subcommand === "comment") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId = parsed.positional[0];
          const text = parsed.positional.slice(1).join(" ");
          if (!issueId || !text) {
            ctx.ui.notify("Usage: /bw comment <issue-id> <text> [--author name]", "info");
            return;
          }

          const issue = await adapter.comment(
            ctx.cwd,
            issueId,
            text,
            readStringOption(parsed.options, "author"),
          );
          await showMutationResult(ctx, "Commented", issue);
          return;
        }

        if (subcommand === "label") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId = parsed.positional[0];
          const operations = parsed.positional.slice(1);
          if (!issueId || operations.length === 0) {
            ctx.ui.notify("Usage: /bw label <issue-id> +label [-label]...", "info");
            return;
          }

          const issue = await adapter.label(ctx.cwd, issueId, operations);
          await showMutationResult(ctx, "Labeled", issue);
          return;
        }

        if (subcommand === "defer") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId = parsed.positional[0];
          const when = parsed.positional.slice(1).join(" ");
          if (!issueId || !when) {
            ctx.ui.notify("Usage: /bw defer <issue-id> <when>", "info");
            return;
          }

          const issue = await adapter.defer(ctx.cwd, issueId, when);
          await showMutationResult(ctx, "Deferred", issue);
          return;
        }

        if (subcommand === "undefer") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId = parsed.positional[0];
          if (!issueId) {
            ctx.ui.notify("Usage: /bw undefer <issue-id>", "info");
            return;
          }

          const issue = await adapter.undefer(ctx.cwd, issueId);
          await showMutationResult(ctx, "Undeferred", issue);
          return;
        }

        if (subcommand === "sync") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          await adapter.sync(ctx.cwd);
          ctx.ui.notify("bw sync completed.", "info");
          return;
        }

        if (subcommand === "workers") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const epicId =
            parsed.positional[0] ??
            (active.state.scope.kind === "epic" ? active.state.scope.id : undefined);
          const workers = await inspectWorkers(ctx, active.activation, active.config, {
            epicId,
          });
          await showWorkers(ctx, workers, epicId);
          return;
        }

        if (subcommand === "delegate") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const ticketId = parsed.positional[0];
          if (!ticketId) {
            ctx.ui.notify("Usage: /bw delegate <ticket-id>", "info");
            return;
          }

          const stateWithPrime = await ensurePrime(
            ctx,
            active.activation,
            active.config,
            active.state,
            false,
          );
          const worker = await launchTicketWorker({
            cwd: ctx.cwd,
            repoRoot: active.activation.repoRoot ?? ctx.cwd,
            config: active.config,
            adapter,
            ticketId,
            epicId: active.state.scope.kind === "epic" ? active.state.scope.id : undefined,
            prime: stateWithPrime.prime?.content,
          });
          ctx.ui.notify(
            `Launched worker ${worker.workerId} for ${worker.ticketId} in the background at ${worker.worktreePath}. ` +
              `You should stay in the current pane while background supervision keeps checking every ${Math.max(1, Math.round(active.config.supervisor.pollIntervalMs / 1000))}s and notifies when the worker exits and when landing completes. Follow streamed worker activity in ${worker.logFile}.`,
            "info",
          );
          const workers = await inspectWorkers(ctx, active.activation, active.config, {
            epicId: worker.epicId,
          });
          const trackedState = await syncWorkerTracking(
            ctx,
            active.activation,
            active.config,
            stateWithPrime,
            workers,
          );
          updateStatusline(
            ctx,
            active.activation,
            trackedState,
            active.config,
            summarizeWorkers(workers),
          );
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

          if (plan.landMode === "multi") {
            resultLines.push(
              "",
              "Next: ask the model to decompose this plan with beadwork_create_issue and beadwork_add_dependency.",
            );
          }

          await showAdoptionResult(ctx, resultLines);
          return;
        }

        if (subcommand === "run") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const epicId =
            parsed.positional[0] ??
            (active.state.scope.kind === "epic" ? active.state.scope.id : undefined);
          if (!epicId) {
            ctx.ui.notify(
              "Usage: /bw run <epic-id> [--workers n] [--until blocked|empty] [--max-cycles n] [--dry-run] [--no-spawn]",
              "info",
            );
            return;
          }

          const epic = await adapter.show(ctx.cwd, epicId);
          if (epic.type !== "epic") {
            ctx.ui.notify(`/bw run requires an epic id. ${epicId} is a ${epic.type}.`, "warning");
            return;
          }

          const stateWithPrime = await ensurePrime(
            ctx,
            active.activation,
            active.config,
            active.state,
            false,
          );
          const options = buildRunOptions(active.config, {
            workers:
              typeof parsed.options.get("workers") === "string"
                ? Number.parseInt(String(parsed.options.get("workers")), 10)
                : undefined,
            until:
              typeof parsed.options.get("until") === "string"
                ? String(parsed.options.get("until"))
                : undefined,
            dryRun: parsed.options.has("dry-run"),
            maxCycles:
              typeof parsed.options.get("max-cycles") === "string"
                ? Number.parseInt(String(parsed.options.get("max-cycles")), 10)
                : undefined,
            noSpawn: parsed.options.has("no-spawn"),
          });
          const scope: Exclude<SessionScope, { kind: "none" }> = {
            kind: "epic",
            id: epic.id,
            title: epic.title,
          };
          const { state } = options.dryRun
            ? await setSessionMode(
                ctx,
                active.activation,
                active.config,
                stateWithPrime,
                "interactive",
                scope,
              )
            : await setSessionMode(
                ctx,
                active.activation,
                active.config,
                stateWithPrime,
                "run",
                scope,
                {
                  workers: options.workers,
                  until: options.until,
                  noSpawn: options.noSpawn,
                  dryRun: false,
                },
              );
          const summary = await runBoundedEpicLoop({
            cwd: ctx.cwd,
            repoRoot: active.activation.repoRoot ?? ctx.cwd,
            config: active.config,
            adapter,
            epicId: epic.id,
            options,
            prime: state.prime?.content,
          });
          await showRunSummary(ctx, summary);
          if (!options.dryRun && summary.stopReason === "max-cycles") {
            ctx.ui.notify(
              `Background supervision remains armed for ${epic.id}; it will keep polling every ${Math.round(
                active.config.supervisor.pollIntervalMs / 1000,
              )}s while work is still active.`,
              "info",
            );
          }
          updateStatusline(ctx, active.activation, state, active.config, summary.workerSummary);
          return;
        }

        ctx.ui.notify(
          "Usage: /bw [status|engage [scope]|prime [--refresh]|ready [scope]|blocked|list [--all --status ... --type ... --parent ... --priority n --assignee ... --grep ... --limit n --deferred --overdue]|history <id> [--limit n]|show <id>|create <title> [--type ... --description ... --priority n --parent id]|update <id> [--title ... --description ... --priority n --assignee ... --status ... --type ... --parent id|--clear-parent --defer when --due when|--clear-due]|dep <add|remove> <blocker> [blocks] <blocked>|start <id>|close <id>|reopen <id>|comment <id> <text>|label <id> +label [-label]|defer <id> <when>|undefer <id>|sync|workers [epic-id]|delegate <ticket-id>|run <epic-id> [--workers n] [--until blocked|empty] [--max-cycles n] [--dry-run] [--no-spawn]|adopt [markdown-plan] [--file path/to/plan.md] [--title ...] [--land quick|branch|multi] [--apply]|off [--stop-workers] [--all-workers] [--leave-workers]]",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(humanizeError(error), "error");
      }
    },
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
      const primedState = await ensurePrime(ctx, activation, config, state, false);
      const worker = await launchTicketWorker({
        cwd: ctx.cwd,
        repoRoot: activation.repoRoot ?? ctx.cwd,
        config,
        adapter,
        ticketId: params.ticket_id,
        epicId: params.epic_id,
        prime: primedState.prime?.content,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(worker, null, 2) }],
        details: worker,
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
