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
import { openDelegateClarify } from "../tui/delegate-clarify.js";
import { openRunClarify } from "../tui/run-clarify.js";
import type {
  ActivationState,
  BeadworkConfig,
  BeadworkIssueDetail,
  SessionState,
  WorkerRuntime,
} from "../types.js";
import { executeDelegateAction } from "./delegate.js";
import { createIssueExplorerDataSource } from "./issues.js";
import { executeRunAction } from "./run.js";
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
    runOptions?: SessionState["runOptions"],
  ) => Promise<{ state: SessionState; scopeDetail?: BeadworkIssueDetail }>;
  writeSessionState: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
  ) => Promise<SessionState>;
  resolveCounts: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    state: SessionState,
  ) => Promise<DashboardStatusSnapshot["counts"]>;
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
                    const clarify = await openDelegateClarify(ctx, { issue });
                    if (!clarify) {
                      return undefined;
                    }

                    await executeDelegateAction({
                      ctx,
                      deps,
                      ticketId: clarify.ticketId,
                      epicId: clarify.epicId,
                      modelOverride: clarify.modelOverride,
                    });
                    return deps.refreshStatus(ctx);
                  },
                  onRunIntent: async (issue) => {
                    const active = await deps.requireActive(ctx);
                    if (!active) {
                      return deps.refreshStatus(ctx);
                    }

                    const defaults = {
                      workers:
                        active.state.runOptions?.workers ??
                        active.state.lastRunOptions?.workers ??
                        active.config.run.defaultWorkers,
                      until:
                        active.state.runOptions?.until ??
                        active.state.lastRunOptions?.until ??
                        active.config.run.defaultUntil,
                      maxCycles:
                        active.state.runOptions?.maxCycles ??
                        active.state.lastRunOptions?.maxCycles ??
                        active.config.run.defaultMaxCycles,
                      dryRun:
                        active.state.runOptions?.dryRun === true ||
                        active.state.lastRunOptions?.dryRun === true,
                      noSpawn:
                        active.state.runOptions?.noSpawn === true ||
                        active.state.lastRunOptions?.noSpawn === true,
                    };
                    const clarify = await openRunClarify(ctx, {
                      epic: issue,
                      defaults,
                      sessionState: active.state,
                    });
                    if (!clarify) {
                      return undefined;
                    }

                    await executeRunAction({
                      ctx,
                      deps,
                      epicId: clarify.epicId,
                      workers: clarify.options.workers,
                      until: clarify.options.until,
                      dryRun: clarify.options.dryRun,
                      maxCycles: clarify.options.maxCycles,
                      noSpawn: clarify.options.noSpawn,
                    });
                    return deps.refreshStatus(ctx);
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
