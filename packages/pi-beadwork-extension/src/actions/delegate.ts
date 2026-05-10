import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { type ParsedArgv, type ParsedModelOverride, parseModelOverride } from "../argv.js";
import type { BeadworkAdapter } from "../bw.js";
import { launchTicketWorker } from "../orchestrator.js";
import { summarizeWorkers } from "../registry.js";
import { updateStatusline } from "../statusline.js";
import type { ActivationState, BeadworkConfig, SessionState, WorkerRuntime } from "../types.js";

export type DelegateActionDeps = {
  adapter: BeadworkAdapter;
  requireActive: (ctx: ExtensionCommandContext) => Promise<{
    activation: ActivationState;
    config: BeadworkConfig;
    state: SessionState;
  } | null>;
  ensurePrime: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    force?: boolean,
  ) => Promise<SessionState>;
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

function describeDelegateLaunch(worker: WorkerRuntime): string {
  if (worker.executionMode === "worktree") {
    return (
      `Launched worktree worker ${worker.workerId} for ${worker.ticketId} in the background [worktree] ` +
      `at worktreePath ${worker.worktreePath}.`
    );
  }

  return (
    `Launched current-branch worker ${worker.workerId} for ${worker.ticketId} in the background [current-branch] ` +
    `in the current branch checkout at checkoutPath ${worker.checkoutPath} (repo root).`
  );
}

function describeDelegateSupervisionOutcome(
  worker: WorkerRuntime,
  landingPolicy: BeadworkConfig["landing"]["policy"],
): string {
  if (worker.executionMode === "worktree") {
    return landingPolicy === "deferred"
      ? "worktree landing is held for explicit /bw land"
      : "worktree landing is completed";
  }

  return "current-branch verification is completed";
}

export async function executeDelegateAction(input: {
  ctx: ExtensionCommandContext;
  deps: DelegateActionDeps;
  ticketId: string;
  epicId?: string;
  modelOverride?: ParsedModelOverride;
}): Promise<WorkerRuntime | null> {
  const { ctx, deps, ticketId, epicId, modelOverride } = input;
  const active = await deps.requireActive(ctx);
  if (!active) {
    return null;
  }

  const stateWithPrime = await deps.ensurePrime(
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
    adapter: deps.adapter,
    ticketId,
    epicId: epicId ?? (active.state.scope.kind === "epic" ? active.state.scope.id : undefined),
    prime: stateWithPrime.prime?.content,
    workerProviderOverride: modelOverride?.provider,
    workerModelOverride: modelOverride?.model,
  });
  const supervisionOutcome = describeDelegateSupervisionOutcome(
    worker,
    active.config.landing.policy,
  );
  const pollSeconds = Math.max(1, Math.round(active.config.supervisor.pollIntervalMs / 1000));
  ctx.ui.notify(
    `${describeDelegateLaunch(worker)} ` +
      `You should stay in the current pane while background supervision keeps checking every ${pollSeconds}s ` +
      `and notifies when the worker exits and when ${supervisionOutcome}. ` +
      `Follow streamed worker activity in ${worker.logFile}.`,
    "info",
  );

  const workers = await deps.inspectWorkers(ctx, active.activation, active.config, {
    epicId: worker.epicId,
  });
  const trackedState = await deps.syncWorkerTracking(
    ctx,
    active.activation,
    active.config,
    stateWithPrime,
    workers,
  );
  updateStatusline(ctx, active.activation, trackedState, active.config, summarizeWorkers(workers));
  return worker;
}

export async function handleDelegateAction(input: {
  subcommand: string;
  parsed: ParsedArgv;
  ctx: ExtensionCommandContext;
  deps: DelegateActionDeps;
}): Promise<boolean> {
  const { subcommand, parsed, ctx, deps } = input;
  if (subcommand !== "delegate") {
    return false;
  }

  const ticketId = parsed.positional[0];
  if (!ticketId) {
    ctx.ui.notify("Usage: /bw delegate <ticket-id> [--model provider/model]", "info");
    return true;
  }

  const modelOverrideValue = parsed.options.get("model");
  const modelOverride =
    typeof modelOverrideValue === "string" ? parseModelOverride(modelOverrideValue) : undefined;

  await executeDelegateAction({
    ctx,
    deps,
    ticketId,
    modelOverride,
  });
  return true;
}
