import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { IssueExplorerFilter } from "../actions/issues.js";
import type {
  ActivationState,
  BeadworkCounts,
  BeadworkIssueDetail,
  SessionState,
  WorkerRuntime,
  WorkerSummary,
} from "../types.js";
import {
  IssueExplorerController,
  type IssueExplorerDataSource,
  type IssueExplorerHooks,
} from "./issue-explorer.js";
import { formatRunManagerLines } from "./run-manager.js";
import { buildWorkerManagerPanelLines } from "./worker-manager.js";

export type DashboardTabId = "issues" | "workers" | "run" | "scope" | "actions";

export type DashboardStatusSnapshot = {
  activation: ActivationState;
  state: SessionState;
  counts?: BeadworkCounts;
  scopeDetail?: BeadworkIssueDetail;
  workerSummary?: WorkerSummary;
  workers?: WorkerRuntime[];
};

export type DashboardModel = DashboardStatusSnapshot & {
  cwd: string;
  defaultTab?: DashboardTabId;
};

export type DashboardIssueExplorerDeps = IssueExplorerHooks & {
  dataSource: IssueExplorerDataSource;
  initialFilter?: IssueExplorerFilter;
};

export type DashboardDeps = {
  issueExplorer?: DashboardIssueExplorerDeps;
};

export const DASHBOARD_TABS: Array<{ id: DashboardTabId; label: string }> = [
  { id: "issues", label: "Issues" },
  { id: "workers", label: "Workers" },
  { id: "run", label: "Run" },
  { id: "scope", label: "Scope" },
  { id: "actions", label: "Actions" },
];

export function canOpenDashboard(activation: ActivationState): boolean {
  return activation.kind === "active" || activation.kind === "available";
}

function describeActivation(activation: ActivationState): string {
  if (activation.kind === "active") {
    return "active";
  }

  const reason = activation.reason ? ` · ${activation.reason}` : "";
  return `${activation.kind}${reason}`;
}

function describeScope(state: SessionState): string {
  if (state.scope.kind === "none") {
    return "repo-wide";
  }

  const title = state.scope.title ? ` · ${state.scope.title}` : "";
  return `${state.scope.kind}:${state.scope.id}${title}`;
}

function describeBackground(state: SessionState): string | undefined {
  const tracked = state.trackedWorkerIds?.length ?? 0;
  const notices = Object.keys(state.workerNotices ?? {}).length;

  if (state.mode === "run" && state.scope.kind === "epic") {
    return `run supervision armed for ${state.scope.id}${tracked > 0 ? ` · tracked=${tracked}` : ""}`;
  }

  if (tracked > 0 || notices > 0) {
    const parts = [`tracked=${tracked}`];
    if (notices > 0) {
      parts.push(`notices=${notices}`);
    }
    return parts.join(" · ");
  }

  if (state.recentRunSummary) {
    return `last run ${state.recentRunSummary.epicId} stopped=${state.recentRunSummary.stopReason}`;
  }

  return undefined;
}

function buildFooterHint(tab: DashboardTabId, issueExplorer?: IssueExplorerController): string {
  if (tab === "issues" && issueExplorer) {
    return issueExplorer.renderFooterHint();
  }
  switch (tab) {
    case "workers":
      return "tab/shift+tab or ←/→ switch tabs • /bw:workers opens the dedicated worker console • esc/q closes";
    case "run":
      return "tab/shift+tab or ←/→ switch tabs • pick an epic in Issues and press r to open run clarify • esc/q closes";
    case "scope":
      return "tab/shift+tab or ←/→ switch tabs • use s/x from Issues or /bw:scope to retarget scope • esc/q closes";
    case "actions":
      return "tab/shift+tab or ←/→ switch tabs • use the listed /bw:* aliases from any session • esc/q closes";
    case "issues":
      return "tab/shift+tab or ←/→ switch tabs • esc/q closes";
  }
}
function buildPanelLines(model: DashboardModel, tab: DashboardTabId): string[] {
  switch (tab) {
    case "issues": {
      if (model.activation.kind === "available") {
        return [
          "This repo looks beadwork-capable, but the beadwork branch is not initialized yet.",
          model.activation.detail ?? "Run the repo's beadwork bootstrap flow to finish setup.",
          "",
          "Initialize beadwork to unlock the ready-first issue explorer, worker console, and run panel.",
        ];
      }

      return [
        "Issue explorer unavailable.",
        "The issue explorer data source was not wired for this dashboard invocation.",
      ];
    }
    case "workers": {
      if (model.activation.kind !== "active") {
        return [
          "Workers become available after beadwork is active in this repository.",
          model.activation.detail ?? "No worker diagnostics are available yet.",
        ];
      }
      return buildWorkerManagerPanelLines({
        workers: model.workers ?? [],
        state: model.state,
        maxWorkersPerGroup: 3,
      });
    }
    case "run":
      return formatRunManagerLines(model);
    case "scope":
      return [
        "Session scope",
        `Mode: ${model.state.mode}`,
        `Scope: ${describeScope(model.state)}`,
        model.scopeDetail
          ? `Scoped issue: ${model.scopeDetail.id} · ${model.scopeDetail.type} · ${model.scopeDetail.status} · ${model.scopeDetail.title}`
          : "Scoped issue: none loaded.",
        model.state.prime?.loadedAt
          ? `Prime: cached ${model.state.prime.loadedAt}`
          : "Prime: loads on the first active workflow action.",
        "",
        "Best next steps:",
        "- use s on the Issues tab to retarget scope to the current selection",
        "- use x on the Issues tab to clear scope back to repo-wide browsing",
        "- use /bw:scope <issue-id|clear> when you want the text-command path",
      ];
    case "actions":
      return [
        "Quick actions",
        "- Issues tab: s scopes the selected issue • d opens delegate clarify • r opens run clarify",
        "- /bw:workers opens the dedicated worker console for selection + follow-up",
        "- /bw:delegate <ticket-id> and /bw:run <epic-id> stay available for text-first launches",
        "- /bw:land, /bw:cancel, and /bw:cleanup accept either ticket ids or worker ids",
        "- /bw status, /bw ready, /bw list, and /bw show remain available alongside the dashboard",
        "",
        "Aliases: /bw:status • /bw:scope • /bw:workers • /bw:delegate • /bw:land • /bw:cancel • /bw:cleanup • /bw:run",
      ];
  }
}

class DashboardComponent implements Component {
  private selectedTabIndex = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly issueExplorer?: IssueExplorerController;
  private readonly model: DashboardModel;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    model: DashboardModel,
    deps: DashboardDeps | undefined,
    private readonly done: (result: undefined) => void,
  ) {
    this.model = { ...model };
    const initialIndex = DASHBOARD_TABS.findIndex((tab) => tab.id === model.defaultTab);
    this.selectedTabIndex = initialIndex >= 0 ? initialIndex : 0;

    if (model.activation.kind === "active" && deps?.issueExplorer) {
      this.issueExplorer = new IssueExplorerController({
        dataSource: deps.issueExplorer.dataSource,
        initialFilter: deps.issueExplorer.initialFilter ?? "ready",
        initialState: model.state,
        onChange: () => this.requestRender(),
        onNotify: deps.issueExplorer.onNotify,
        onEngageRepoWide: this.wrapSnapshotHook(deps.issueExplorer.onEngageRepoWide),
        onScopeSelection: this.wrapIssueSnapshotHook(deps.issueExplorer.onScopeSelection),
        onClearScope: this.wrapSnapshotHook(deps.issueExplorer.onClearScope),
        onDelegateIntent: this.wrapIssueSnapshotHook(deps.issueExplorer.onDelegateIntent),
        onRunIntent: this.wrapIssueSnapshotHook(deps.issueExplorer.onRunIntent),
      });
      void this.issueExplorer.initialize();
    }
  }

  private get selectedTab(): DashboardTabId {
    return DASHBOARD_TABS[this.selectedTabIndex]?.id ?? "issues";
  }

  private wrapSnapshotHook(
    hook: (() => Promise<DashboardStatusSnapshot | undefined>) | undefined,
  ): (() => Promise<DashboardStatusSnapshot | undefined>) | undefined {
    if (!hook) {
      return undefined;
    }

    return async () => {
      const snapshot = await hook();
      this.applySnapshot(snapshot);
      return snapshot;
    };
  }

  private wrapIssueSnapshotHook(
    hook:
      | ((issue: BeadworkIssueDetail) => Promise<DashboardStatusSnapshot | undefined>)
      | undefined,
  ): ((issue: BeadworkIssueDetail) => Promise<DashboardStatusSnapshot | undefined>) | undefined {
    if (!hook) {
      return undefined;
    }

    return async (issue) => {
      const snapshot = await hook(issue);
      this.applySnapshot(snapshot);
      return snapshot;
    };
  }

  private applySnapshot(snapshot: DashboardStatusSnapshot | undefined): void {
    if (!snapshot) {
      return;
    }

    this.model.activation = snapshot.activation;
    this.model.state = snapshot.state;
    this.model.counts = snapshot.counts;
    this.model.scopeDetail = snapshot.scopeDetail;
    this.model.workerSummary = snapshot.workerSummary;
    this.model.workers = snapshot.workers;
    this.issueExplorer?.setSessionState(snapshot.state);
    this.requestRender();
  }

  private requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.selectedTab === "issues" && this.issueExplorer?.handleInput(data)) {
      return;
    }

    if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
      this.selectedTabIndex =
        (this.selectedTabIndex + DASHBOARD_TABS.length - 1) % DASHBOARD_TABS.length;
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.selectedTabIndex = (this.selectedTabIndex + 1) % DASHBOARD_TABS.length;
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
      this.done(undefined);
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const headerLines = [
      this.theme.fg("accent", this.theme.bold("Beadwork Dashboard")),
      `Repo: ${this.model.activation.repoRoot ?? this.model.cwd}`,
      `Activation: ${describeActivation(this.model.activation)}`,
      `Mode: ${this.model.state.mode}`,
      `Scope: ${describeScope(this.model.state)}`,
    ];

    const background = describeBackground(this.model.state);
    if (background) {
      headerLines.push(`Background: ${background}`);
    }

    if (this.model.counts) {
      headerLines.push(
        `Counts: ready=${this.model.counts.ready} blocked=${this.model.counts.blocked} in_progress=${this.model.counts.inProgress}`,
      );
    }

    if (this.model.workerSummary && this.model.workerSummary.total > 0) {
      headerLines.push(
        `Workers: total=${this.model.workerSummary.total} active=${this.model.workerSummary.active} held=${this.model.workerSummary.held} landed=${this.model.workerSummary.landed}`,
      );
    }

    const tabsLine = DASHBOARD_TABS.map((tab, index) => {
      const label = ` ${index === this.selectedTabIndex ? "●" : "○"} ${tab.label} `;
      return index === this.selectedTabIndex ? this.theme.fg("accent", label) : label;
    }).join(" ");

    const bodyLines =
      this.selectedTab === "issues" && this.issueExplorer
        ? this.issueExplorer.renderLines()
        : buildPanelLines(this.model, this.selectedTab);
    const footer = this.theme.fg("dim", buildFooterHint(this.selectedTab, this.issueExplorer));

    const lines = [...headerLines, "", tabsLine, "", ...bodyLines, "", footer].flatMap((line) =>
      wrapTextWithAnsi(line, Math.max(1, width)).map((wrapped) => truncateToWidth(wrapped, width)),
    );

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export async function openBeadworkDashboard(
  ctx: ExtensionCommandContext,
  model: DashboardModel,
  deps?: DashboardDeps,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new DashboardComponent(tui, theme, model, deps, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: 92,
        maxHeight: "85%",
        margin: 1,
      },
    },
  );
}
