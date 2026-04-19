import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ParsedArgv } from "../argv.js";
import { showPrime, showStatus } from "../commands.js";
import {
  canOpenDashboard,
  type DashboardStatusSnapshot,
  type DashboardTabId,
  openBeadworkDashboard,
} from "../tui/dashboard.js";
import type { ActivationState, BeadworkConfig, SessionState } from "../types.js";

export type StatusActionDeps = {
  refreshStatus: (ctx: ExtensionCommandContext) => Promise<DashboardStatusSnapshot>;
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
};

export async function handleStatusAction(input: {
  subcommand: string;
  parsed: ParsedArgv;
  isBare: boolean;
  ctx: ExtensionCommandContext;
  deps: StatusActionDeps;
  defaultTab?: DashboardTabId;
}): Promise<boolean> {
  const { subcommand, parsed, isBare, ctx, deps } = input;

  if (subcommand === "status") {
    const status = await deps.refreshStatus(ctx);
    if (isBare && canOpenDashboard(status.activation) && ctx.hasUI) {
      await openBeadworkDashboard(ctx, {
        ...status,
        cwd: ctx.cwd,
        defaultTab: input.defaultTab ?? "issues",
      });
      return true;
    }

    await showStatus(ctx, status);
    return true;
  }

  if (subcommand === "prime") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const refresh = parsed.options.has("refresh");
    const state = await deps.ensurePrime(
      ctx,
      active.activation,
      active.config,
      active.state,
      refresh,
    );
    await showPrime(ctx, state.prime?.content ?? "", state.prime?.loadedAt);
    return true;
  }

  return false;
}
