import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { type ParsedArgv, parseModelOverride } from "../argv.js";
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

  const active = await deps.requireActive(ctx);
  if (!active) {
    return true;
  }

  const ticketId = parsed.positional[0];
  if (!ticketId) {
    ctx.ui.notify("Usage: /bw delegate <ticket-id> [--model provider/model]", "info");
    return true;
  }

  const modelOverrideValue = parsed.options.get("model");
  const modelOverride =
    typeof modelOverrideValue === "string" ? parseModelOverride(modelOverrideValue) : undefined;

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
    epicId: active.state.scope.kind === "epic" ? active.state.scope.id : undefined,
    prime: stateWithPrime.prime?.content,
    workerProviderOverride: modelOverride?.provider,
    workerModelOverride: modelOverride?.model,
  });
  const landingMode = active.config.landing.policy === "deferred" ? "held" : "completed";
  ctx.ui.notify(
    `Launched worker ${worker.workerId} for ${worker.ticketId} in the background at ${worker.worktreePath}. ` +
      `You should stay in the current pane while background supervision keeps checking every ${Math.max(1, Math.round(active.config.supervisor.pollIntervalMs / 1000))}s and notifies when the worker exits and when landing is ${landingMode}. Follow streamed worker activity in ${worker.logFile}.`,
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
  return true;
}
