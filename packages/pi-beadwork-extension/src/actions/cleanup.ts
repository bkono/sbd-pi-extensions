import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ParsedArgv } from "../argv.js";
import { showStatus } from "../commands.js";
import type { ActivationState, BeadworkConfig, SessionState } from "../types.js";

export type CleanupActionDeps = {
  loadConfig: (cwd: string) => BeadworkConfig;
  detectActivation: (cwd: string) => Promise<ActivationState>;
  resetState: (ctx: ExtensionCommandContext) => Promise<SessionState>;
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
  const state = await deps.resetState(ctx);
  ctx.ui.notify("Beadwork session mode reset to neutral.", "info");
  await showStatus(ctx, { activation, state, config });
  return true;
}
