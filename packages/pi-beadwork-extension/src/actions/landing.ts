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
    landed
      ? `Delegated ticket ${worker.ticketId} [${worker.executionMode}] landed successfully. ${inspection.followUp.action}`
      : `Queued landing retry for ${worker.ticketId} [${worker.executionMode}]. Background supervision will keep validating/reviewing/merging and notify when it finishes. ${inspection.followUp.action}`,
    level,
  );
  return true;
}
