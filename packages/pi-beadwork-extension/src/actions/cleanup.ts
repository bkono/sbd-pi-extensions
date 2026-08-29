import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ParsedArgv } from "../argv.js";
import { showStatus } from "../commands.js";
import type { ActivationState, BeadworkConfig, SessionState } from "../types.js";
import { buildGoalHaltPrompt, injectGoalHaltContinuation, scopedGoalEpicId } from "./goal-exit.js";
import type { GoalPromptInjector } from "./run.js";

const FALLBACK_HALT_LABEL = "current goal";

export type CleanupActionDeps = {
  loadConfig: (cwd: string) => BeadworkConfig;
  detectActivation: (cwd: string) => Promise<ActivationState>;
  readState: (
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
  ) => Promise<SessionState>;
  resetState: (ctx: ExtensionCommandContext) => Promise<SessionState>;
  pi: GoalPromptInjector;
  parentIsBusy: (ctx: ExtensionCommandContext) => boolean;
};

export async function handleCleanupAction(input: {
  subcommand: string;
  parsed: ParsedArgv;
  ctx: ExtensionCommandContext;
  deps: CleanupActionDeps;
}): Promise<boolean> {
  const { subcommand, ctx, deps } = input;

  if (subcommand !== "off") {
    return false;
  }

  const config = deps.loadConfig(ctx.cwd);
  const activation = await deps.detectActivation(ctx.cwd);
  const previous = await deps.readState(ctx, activation, config);
  const state = await deps.resetState(ctx);

  const epicId = scopedGoalEpicId(previous) ?? FALLBACK_HALT_LABEL;
  try {
    injectGoalHaltContinuation(deps.pi, buildGoalHaltPrompt(epicId), deps.parentIsBusy(ctx));
  } catch {
    // Reset already persisted; halt is best-effort.
  }

  ctx.ui.notify("Beadwork session mode reset to neutral.", "info");
  await showStatus(ctx, { activation, state, config });
  return true;
}
