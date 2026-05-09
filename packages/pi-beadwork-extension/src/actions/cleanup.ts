import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ParsedArgv } from "../argv.js";
import { showStatus } from "../commands.js";
import { stopWorkers } from "../orchestrator.js";
import {
  loadWorkerRegistry,
  resolveWorkerRegistryPath,
  resolveWorkerRuntimeDir,
  saveWorkerRegistry,
} from "../registry.js";
import { getWorkerActionAvailability } from "../tui/worker-manager.js";
import {
  type ActivationState,
  type BeadworkConfig,
  isWorktreeWorker,
  type SessionState,
  type WorkerRuntime,
} from "../types.js";
import { cleanupTicketWorktree } from "../worktree.js";

function matchesWorkerTarget(worker: WorkerRuntime, target: string): boolean {
  return worker.workerId === target || worker.ticketId === target;
}

export type CleanupActionDeps = {
  loadConfig: (cwd: string) => BeadworkConfig;
  detectActivation: (cwd: string) => Promise<ActivationState>;
  readSessionState: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
  ) => Promise<SessionState>;
  resetState: (ctx: ExtensionCommandContext) => Promise<SessionState>;
  inspectWorkers: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    options?: { epicId?: string; workerIds?: string[] },
  ) => Promise<WorkerRuntime[]>;
  requireActive: (ctx: ExtensionCommandContext) => Promise<{
    activation: ActivationState;
    config: BeadworkConfig;
    state: SessionState;
  } | null>;
};

export async function handleCleanupAction(input: {
  subcommand: string;
  parsed: ParsedArgv;
  ctx: ExtensionCommandContext;
  deps: CleanupActionDeps;
}): Promise<boolean> {
  const { subcommand, parsed, ctx, deps } = input;

  if (subcommand === "off") {
    const config = deps.loadConfig(ctx.cwd);
    const activation = await deps.detectActivation(ctx.cwd);
    const currentState = await deps.readSessionState(ctx, activation, config);
    const stopWorkersRequested = parsed.options.has("stop-workers");
    const leaveWorkers = parsed.options.has("leave-workers");
    const stopAllWorkers = parsed.options.has("all-workers");

    const activeWorkers =
      activation.kind === "active" && activation.repoRoot
        ? (await deps.inspectWorkers(ctx, activation, config)).filter(
            (worker) => worker.status === "launching" || worker.status === "running",
          )
        : [];
    const scopedEpicId =
      !stopAllWorkers && currentState.scope.kind === "epic" ? currentState.scope.id : undefined;

    if (activeWorkers.length > 0 && !stopWorkersRequested && !leaveWorkers) {
      const stopHint = scopedEpicId
        ? `/bw off --stop-workers (current epic ${scopedEpicId})`
        : "/bw off --stop-workers";
      ctx.ui.notify(
        `Active beadwork workers are still running (${activeWorkers.length}). Run ${stopHint} to stop them first, or /bw off --leave-workers to reset this session and leave them running.`,
        "warning",
      );
      return true;
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

    const state = await deps.resetState(ctx);
    ctx.ui.notify(
      leaveWorkers && activeWorkers.length > 0
        ? "Beadwork session mode reset to neutral; active workers were left running."
        : "Beadwork session mode reset to neutral.",
      "info",
    );
    await showStatus(ctx, { activation, state });
    return true;
  }

  if (subcommand === "cleanup") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const target = parsed.positional[0];
    if (!target) {
      ctx.ui.notify("Usage: /bw cleanup <ticket-id|worker-id>", "info");
      return true;
    }

    const registryPath = resolveWorkerRegistryPath(
      active.activation.repoRoot ?? ctx.cwd,
      active.config.storage.workerRegistryFile,
    );
    const workers = await loadWorkerRegistry(registryPath);
    const worker = workers.find((entry) => matchesWorkerTarget(entry, target));
    if (!worker) {
      ctx.ui.notify(`No worker matched ${target}.`, "warning");
      return true;
    }

    const cleanupAction = getWorkerActionAvailability(worker).cleanup;
    if (!cleanupAction.enabled) {
      ctx.ui.notify(`Cannot cleanup ${target}: ${cleanupAction.reason}.`, "warning");
      return true;
    }
    if (!isWorktreeWorker(worker)) {
      ctx.ui.notify(`Cannot cleanup ${target}: worker is not worktree-backed.`, "warning");
      return true;
    }

    const runtimeRoot = resolveWorkerRuntimeDir(
      active.activation.repoRoot ?? ctx.cwd,
      active.config.storage.runtimeDir,
    );
    const cleanup = await cleanupTicketWorktree({
      repoRoot: active.activation.repoRoot ?? ctx.cwd,
      worktreePath: worker.worktreePath,
      runtimeDir: worker.runtimeDir,
      runtimeRoot,
    });
    const now = new Date().toISOString();
    const updatedWorker: WorkerRuntime = {
      ...worker,
      cleanupStatus: cleanup.removed || cleanup.runtimeRemoved ? "cleaned" : worker.cleanupStatus,
      cleanupAt: cleanup.removed || cleanup.runtimeRemoved ? now : worker.cleanupAt,
      updatedAt: now,
      status: worker.status === "landed" ? "landed" : worker.status,
    };
    await saveWorkerRegistry(
      registryPath,
      workers.map((entry) => (entry.workerId === worker.workerId ? updatedWorker : entry)),
    );
    ctx.ui.notify(
      `Cleanup completed for ${worker.ticketId}: worktree ${cleanup.removed ? "removed" : "already gone"}, runtime ${cleanup.runtimeRemoved ? "removed" : "already gone"}.`,
      "info",
    );
    return true;
  }

  return false;
}
