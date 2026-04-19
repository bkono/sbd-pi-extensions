import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ParsedArgv } from "../argv.js";
import { showWorkers } from "../commands.js";
import { stopWorkers } from "../orchestrator.js";
import { summarizeWorkers } from "../registry.js";
import { updateStatusline } from "../statusline.js";
import type { ActivationState, BeadworkConfig, SessionState, WorkerRuntime } from "../types.js";

function matchesWorkerTarget(worker: WorkerRuntime, target: string): boolean {
  return worker.workerId === target || worker.ticketId === target;
}

export type WorkersActionDeps = {
  requireActive: (ctx: ExtensionCommandContext) => Promise<{
    activation: ActivationState;
    config: BeadworkConfig;
    state: SessionState;
  } | null>;
  inspectWorkers: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    options?: { epicId?: string; workerIds?: string[] },
  ) => Promise<WorkerRuntime[]>;
  syncWorkerTracking: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    workers: WorkerRuntime[],
  ) => Promise<SessionState>;
};

export async function handleWorkersAction(input: {
  subcommand: string;
  parsed: ParsedArgv;
  ctx: ExtensionCommandContext;
  deps: WorkersActionDeps;
}): Promise<boolean> {
  const { subcommand, parsed, ctx, deps } = input;

  if (subcommand === "workers") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const epicId =
      parsed.positional[0] ??
      (active.state.scope.kind === "epic" ? active.state.scope.id : undefined);
    const workers = await deps.inspectWorkers(ctx, active.activation, active.config, {
      epicId,
    });
    await showWorkers(ctx, workers, epicId);
    return true;
  }

  if (subcommand === "cancel") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const target = parsed.positional[0];
    if (!target) {
      ctx.ui.notify("Usage: /bw cancel <ticket-id|worker-id>", "info");
      return true;
    }

    const workers = await deps.inspectWorkers(ctx, active.activation, active.config);
    const matchingWorkers = workers.filter((worker) => matchesWorkerTarget(worker, target));
    if (matchingWorkers.length === 0) {
      ctx.ui.notify(`No worker matched ${target}.`, "warning");
      return true;
    }

    const activeWorkers = matchingWorkers.filter(
      (worker) => worker.status === "launching" || worker.status === "running",
    );
    if (activeWorkers.length === 0) {
      ctx.ui.notify(`No active worker matched ${target}.`, "warning");
      return true;
    }

    const stopped = await stopWorkers({
      repoRoot: active.activation.repoRoot ?? ctx.cwd,
      config: active.config,
      workerIds: activeWorkers.map((worker) => worker.workerId),
      reason: `Stopped by /bw cancel for ${target}.`,
    });
    const refreshedWorkers = await deps.inspectWorkers(ctx, active.activation, active.config);
    const nextState = await deps.syncWorkerTracking(
      ctx,
      active.activation,
      active.config,
      active.state,
      refreshedWorkers,
    );
    updateStatusline(
      ctx,
      active.activation,
      nextState,
      active.config,
      summarizeWorkers(refreshedWorkers),
    );
    ctx.ui.notify(
      `Stopped ${stopped.length} worker(s) for ${target}.`,
      stopped.some((worker) => worker.status === "failed") ? "warning" : "info",
    );
    return true;
  }

  return false;
}
