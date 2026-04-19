import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ParsedArgv } from "../argv.js";
import type { BeadworkAdapter } from "../bw.js";
import { showPrime, showStatus } from "../commands.js";
import {
  canOpenDashboard,
  type DashboardStatusSnapshot,
  type DashboardTabId,
  openBeadworkDashboard,
} from "../tui/dashboard.js";
import type {
  ActivationState,
  BeadworkConfig,
  BeadworkIssueDetail,
  SessionState,
} from "../types.js";
import { createIssueExplorerDataSource } from "./issues.js";
import { clearInteractiveScope, setInteractiveScope } from "./scope.js";

export type StatusActionDeps = {
  adapter: BeadworkAdapter;
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
  setSessionMode: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    mode: SessionState["mode"],
    scope?: SessionState["scope"],
  ) => Promise<{ state: SessionState; scopeDetail?: BeadworkIssueDetail }>;
  resolveCounts: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    state: SessionState,
  ) => Promise<DashboardStatusSnapshot["counts"]>;
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
      await openBeadworkDashboard(
        ctx,
        {
          ...status,
          cwd: ctx.cwd,
          defaultTab: input.defaultTab ?? "issues",
        },
        {
          issueExplorer:
            status.activation.kind === "active"
              ? {
                  dataSource: createIssueExplorerDataSource({
                    adapter: deps.adapter,
                    cwd: ctx.cwd,
                  }),
                  initialFilter: "ready",
                  onNotify: (message, level) => ctx.ui.notify(message, level),
                  onEngageRepoWide: async () => {
                    const active = await deps.requireActive(ctx);
                    if (!active) {
                      return deps.refreshStatus(ctx);
                    }

                    await setInteractiveScope({
                      ctx,
                      activation: active.activation,
                      config: active.config,
                      state: active.state,
                      deps,
                      scope: { kind: "none" },
                    });
                    ctx.ui.notify("Beadwork interactive mode engaged repo-wide.", "info");
                    return deps.refreshStatus(ctx);
                  },
                  onScopeSelection: async (issue) => {
                    const active = await deps.requireActive(ctx);
                    if (!active) {
                      return deps.refreshStatus(ctx);
                    }

                    await setInteractiveScope({
                      ctx,
                      activation: active.activation,
                      config: active.config,
                      state: active.state,
                      deps,
                      scope: {
                        kind: issue.type === "epic" ? "epic" : "ticket",
                        id: issue.id,
                        title: issue.title,
                      },
                    });
                    ctx.ui.notify(
                      `Beadwork scope retargeted to ${issue.type === "epic" ? "epic" : "ticket"} ${issue.id}.`,
                      "info",
                    );
                    return deps.refreshStatus(ctx);
                  },
                  onClearScope: async () => {
                    const active = await deps.requireActive(ctx);
                    if (!active) {
                      return deps.refreshStatus(ctx);
                    }

                    await clearInteractiveScope({
                      ctx,
                      activation: active.activation,
                      config: active.config,
                      state: active.state,
                      deps,
                    });
                    ctx.ui.notify("Beadwork scope cleared; repo-wide browsing active.", "info");
                    return deps.refreshStatus(ctx);
                  },
                  onDelegateIntent: async (issue) => {
                    ctx.ui.notify(
                      `Delegate intent queued for ${issue.id}; a clarify modal will land in a later ticket.`,
                      "info",
                    );
                  },
                  onRunIntent: async (issue) => {
                    ctx.ui.notify(
                      `Run intent queued for ${issue.id}; a clarify modal will land in a later ticket.`,
                      "info",
                    );
                  },
                }
              : undefined,
        },
      );
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
