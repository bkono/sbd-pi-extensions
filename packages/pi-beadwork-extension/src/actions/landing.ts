import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ParsedArgv } from "../argv.js";
import type { BeadworkAdapter } from "../bw.js";
import { requestWorkerLanding } from "../orchestrator.js";
import { loadWorkerRegistry, resolveWorkerRegistryPath } from "../registry.js";
import { getWorkerActionAvailability } from "../tui/worker-manager.js";
import type { ActivationState, BeadworkConfig, SessionState, WorkerRuntime } from "../types.js";
import { isSuccessfulTerminalWorker } from "../types.js";
import { inspectWorker } from "../worker-diagnostics.js";

export type LandingActionDeps = {
  adapter: BeadworkAdapter;
  requireActive: (ctx: ExtensionCommandContext) => Promise<{
    activation: ActivationState;
    config: BeadworkConfig;
    state: SessionState;
  } | null>;
  trackWorkerForBackground: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    worker: WorkerRuntime,
  ) => Promise<SessionState>;
};

function formatLandingActionNotification(input: {
  worker: WorkerRuntime;
  landed: boolean;
  followUpAction: string;
}): string {
  const { worker, landed, followUpAction } = input;

  if (worker.executionMode === "worktree") {
    return landed
      ? `Delegated ticket ${worker.ticketId} [worktree] landed successfully. ${followUpAction}`
      : `Queued worktree landing retry for ${worker.ticketId} [worktree]. Background supervision will keep validating/reviewing/merging and notify when it finishes. ${followUpAction}`;
  }

  return landed
    ? `Delegated ticket ${worker.ticketId} [current-branch] verified successfully. ${followUpAction}`
    : `Queued current-branch verification retry for ${worker.ticketId} [current-branch]. Background supervision will keep validating/reviewing the current branch and notify when it finishes. ${followUpAction}`;
}

export async function handleLandingAction(input: {
  subcommand: string;
  parsed: ParsedArgv;
  ctx: ExtensionCommandContext;
  deps: LandingActionDeps;
}): Promise<boolean> {
  const { subcommand, parsed, ctx, deps } = input;
  if (subcommand !== "land") {
    return false;
  }

  const active = await deps.requireActive(ctx);
  if (!active) {
    return true;
  }

  const target = parsed.positional[0];
  if (!target) {
    ctx.ui.notify("Usage: /bw land <ticket-id|worker-id>", "info");
    return true;
  }

  const workers = await loadWorkerRegistry(
    resolveWorkerRegistryPath(
      active.activation.repoRoot ?? ctx.cwd,
      active.config.storage.workerRegistryFile,
    ),
  );
  const targetWorker = workers
    .filter((candidate) => candidate.workerId === target || candidate.ticketId === target)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];

  if (!targetWorker) {
    ctx.ui.notify(`No worker matched ${target}.`, "warning");
    return true;
  }

  const landAction = getWorkerActionAvailability(targetWorker).land;
  if (!landAction.enabled) {
    ctx.ui.notify(`Cannot land ${target}: ${landAction.reason}.`, "warning");
    return true;
  }
  let worker: WorkerRuntime | undefined;
  let lastError: unknown;
  try {
    worker = await requestWorkerLanding({
      cwd: ctx.cwd,
      repoRoot: active.activation.repoRoot ?? ctx.cwd,
      config: active.config,
      adapter: deps.adapter,
      ticketId: target,
    });
  } catch (error) {
    lastError = error;
  }
  if (!worker) {
    worker = await requestWorkerLanding({
      cwd: ctx.cwd,
      repoRoot: active.activation.repoRoot ?? ctx.cwd,
      config: active.config,
      adapter: deps.adapter,
      workerId: target,
    }).catch((error) => {
      throw lastError ?? error;
    });
  }
  const inspection = inspectWorker(worker);
  const landed = isSuccessfulTerminalWorker(worker);
  const level = inspection.followUp.needsAttention ? "warning" : "info";
  await deps.trackWorkerForBackground(ctx, active.activation, active.config, active.state, worker);
  ctx.ui.notify(
    formatLandingActionNotification({
      worker,
      landed,
      followUpAction: inspection.followUp.action,
    }),
    level,
  );
  return true;
}
