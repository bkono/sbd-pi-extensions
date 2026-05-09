import path from "node:path";
import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
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
  renderSurface,
  renderTabLine,
  sectionTitle,
  statusStyle,
  styledAccent,
  styledDim,
  styledError,
  styledLabel,
  styledSuccess,
  styledValue,
  styledWarning,
  typeBadge,
} from "./common.js";
import {
  IssueExplorerController,
  type IssueExplorerDataSource,
  type IssueExplorerHooks,
} from "./issue-explorer.js";
import { formatRunManagerLines } from "./run-manager.js";
import {
  buildWorkerFooterHint,
  buildWorkerManagerPanelLines,
  groupWorkersForManager,
  type WorkerActionKind,
  type WorkerManagerEntry,
} from "./worker-manager.js";

export type DashboardTabId = "issues" | "workers" | "run" | "scope";

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

export type DashboardWorkerActionDeps = {
  onLand?: (worker: WorkerRuntime) => Promise<DashboardStatusSnapshot | undefined>;
  onCancel?: (worker: WorkerRuntime) => Promise<DashboardStatusSnapshot | undefined>;
  onCleanup?: (worker: WorkerRuntime) => Promise<DashboardStatusSnapshot | undefined>;
  onNotify?: (message: string, level?: "info" | "warning") => void;
};

export type DashboardDeps = {
  issueExplorer?: DashboardIssueExplorerDeps;
  workerActions?: DashboardWorkerActionDeps;
};

export const DASHBOARD_TABS: Array<{ id: DashboardTabId; label: string }> = [
  { id: "issues", label: "Issues" },
  { id: "workers", label: "Workers" },
  { id: "run", label: "Run" },
  { id: "scope", label: "Scope" },
];

export function canOpenDashboard(activation: ActivationState): boolean {
  return activation.kind === "active" || activation.kind === "available";
}

function describeActivation(theme: Theme, activation: ActivationState): string {
  if (activation.kind === "active") {
    return styledSuccess(theme, "active");
  }

  const label =
    activation.kind === "available"
      ? styledAccent(theme, activation.kind)
      : styledWarning(theme, activation.kind);
  const reason = activation.reason ? ` · ${styledDim(theme, activation.reason)}` : "";
  return `${label}${reason}`;
}

function describeScope(theme: Theme, state: SessionState, maxTitleWidth = 28): string {
  if (state.scope.kind === "none") {
    return styledDim(theme, "repo-wide");
  }
  const title = state.scope.title
    ? ` · ${styledDim(theme, truncateToWidth(state.scope.title, Math.max(12, maxTitleWidth), "…"))}`
    : "";
  return `${styledAccent(theme, state.scope.kind)}:${styledValue(theme, state.scope.id)}${title}`;
}

function describeBackground(theme: Theme, state: SessionState): string | undefined {
  const tracked = state.trackedWorkerIds?.length ?? 0;
  const notices = Object.keys(state.workerNotices ?? {}).length;
  if (state.mode === "run" && state.scope.kind === "epic") {
    const trackedPart =
      tracked > 0
        ? ` \u00b7 ${styledLabel(theme, "tracked")} ${styledAccent(theme, String(tracked))}`
        : "";
    return `${styledAccent(theme, "run armed")} for ${styledValue(theme, state.scope.id)}${trackedPart}`;
  }
  if (tracked > 0 || notices > 0) {
    const parts = [`${styledLabel(theme, "tracked")} ${styledAccent(theme, String(tracked))}`];
    if (notices > 0) {
      parts.push(`${styledLabel(theme, "notices")} ${styledWarning(theme, String(notices))}`);
    }
    return parts.join(" · ");
  }
  if (state.recentRunSummary) {
    return `${styledLabel(theme, "last run")} ${state.recentRunSummary.epicId} · ${styledDim(theme, state.recentRunSummary.stopReason)}`;
  }

  return undefined;
}

function describeCounts(theme: Theme, counts?: BeadworkCounts): string | undefined {
  if (!counts) {
    return undefined;
  }

  const sc = (n: number, label: string, tone: (t: Theme, s: string) => string) =>
    `${styledLabel(theme, label)} ${n > 0 ? tone(theme, String(n)) : styledDim(theme, "0")}`;
  return [
    sc(counts.ready, "ready", styledSuccess),
    sc(counts.blocked, "blocked", styledError),
    sc(counts.inProgress, "in progress", styledAccent),
  ].join(" · ");
}

function describeWorkerSummary(theme: Theme, workerSummary?: WorkerSummary): string | undefined {
  if (!workerSummary || workerSummary.total === 0) {
    return undefined;
  }

  const sw = (n: number, label: string, tone: (t: Theme, s: string) => string) =>
    `${styledLabel(theme, label)} ${n > 0 ? tone(theme, String(n)) : styledDim(theme, "0")}`;
  return [
    sw(workerSummary.total, "workers", styledValue),
    sw(workerSummary.active, "active", styledAccent),
    sw(workerSummary.held, "held", styledWarning),
    sw(workerSummary.successfulTerminal, "done", styledSuccess),
    sw(workerSummary.landed, "landed", styledSuccess),
    sw(workerSummary.verified, "verified", styledSuccess),
    sw(workerSummary.failed, "failed", styledError),
    sw(workerSummary.attention, "attention", styledWarning),
  ].join(" · ");
}

function buildFooterHint(
  tab: DashboardTabId,
  issueExplorer?: IssueExplorerController,
  selectedWorker?: WorkerManagerEntry,
): string {
  if (tab === "issues" && issueExplorer) {
    return issueExplorer.renderFooterHint();
  }
  switch (tab) {
    case "workers":
      return buildWorkerFooterHint(selectedWorker);
    case "run":
      return "tab switch • r from Issues starts a run";
    case "scope":
      return "scope from Issues with s • clear with x";
    case "issues":
      return "tab switch • esc close";
  }
}

function buildPanelLines(theme: Theme, model: DashboardModel, tab: DashboardTabId): string[] {
  switch (tab) {
    case "issues": {
      if (model.activation.kind === "available") {
        return [
          styledWarning(
            theme,
            "This repo looks beadwork-capable, but the beadwork branch is not initialized yet.",
          ),
          styledDim(
            theme,
            model.activation.detail ?? "Run the repo's beadwork bootstrap flow to finish setup.",
          ),
          "",
          styledDim(
            theme,
            "Initialize beadwork to unlock the issue explorer, worker controls, and run panel.",
          ),
        ];
      }

      return [
        styledDim(theme, "Issue explorer unavailable."),
        styledDim(
          theme,
          "The issue explorer data source was not wired for this dashboard invocation.",
        ),
      ];
    }
    case "workers": {
      if (model.activation.kind !== "active") {
        return [
          styledDim(theme, "Workers become available after beadwork is active in this repository."),
          styledDim(theme, model.activation.detail ?? "No worker diagnostics are available yet."),
        ];
      }

      return [
        styledDim(theme, "Workers tab unavailable."),
        styledDim(theme, "The worker manager was not wired for this dashboard invocation."),
      ];
    }
    case "run":
      return formatRunManagerLines(model, theme);
    case "scope":
      return [
        sectionTitle(theme, "Current scope"),
        `${styledDim(theme, model.state.mode)} \u00b7 ${describeScope(theme, model.state)}`,
        model.scopeDetail
          ? `${styledAccent(theme, model.scopeDetail.id)} \u00b7 ${typeBadge(theme, model.scopeDetail.type)} \u00b7 ${statusStyle(theme, model.scopeDetail.status)}`
          : styledDim(theme, "No scoped issue detail loaded."),
        model.scopeDetail?.title
          ? styledValue(theme, model.scopeDetail.title)
          : styledDim(theme, "Scope an issue from the Issues tab."),
        model.state.prime?.loadedAt
          ? styledDim(theme, `Prime cached ${model.state.prime.loadedAt}`)
          : styledDim(theme, "Prime loads on the first active workflow action."),
      ];
  }
}

class DashboardComponent implements Component {
  private selectedTabIndex = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly issueExplorer?: IssueExplorerController;
  private selectedWorkerId?: string;
  private readonly model: DashboardModel;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    model: DashboardModel,
    private readonly deps: DashboardDeps | undefined,
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

  private get workerEntries(): WorkerManagerEntry[] {
    return groupWorkersForManager({
      workers: this.model.workers ?? [],
      state: this.model.state,
    }).flatMap((group) => group.workers);
  }

  private get selectedWorkerEntry(): WorkerManagerEntry | undefined {
    const entries = this.workerEntries;
    if (entries.length === 0) {
      this.selectedWorkerId = undefined;
      return undefined;
    }

    const selected = this.selectedWorkerId
      ? entries.find((entry) => entry.worker.workerId === this.selectedWorkerId)
      : undefined;
    if (selected) {
      return selected;
    }

    this.selectedWorkerId = entries[0]?.worker.workerId;
    return entries[0];
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

    if (
      this.selectedWorkerId &&
      !(snapshot.workers ?? []).some((worker) => worker.workerId === this.selectedWorkerId)
    ) {
      this.selectedWorkerId = snapshot.workers?.[0]?.workerId;
    }

    this.requestRender();
  }

  private requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private moveWorkerSelection(delta: number): void {
    const entries = this.workerEntries;
    if (entries.length === 0) {
      return;
    }

    const selected = this.selectedWorkerEntry;
    const currentIndex = selected
      ? entries.findIndex((entry) => entry.worker.workerId === selected.worker.workerId)
      : 0;
    const nextIndex = Math.max(0, Math.min(entries.length - 1, currentIndex + delta));
    this.selectedWorkerId = entries[nextIndex]?.worker.workerId;
    this.requestRender();
  }

  private async requestWorkerAction(kind: WorkerActionKind): Promise<void> {
    const entry = this.selectedWorkerEntry;
    if (!entry) {
      this.deps?.workerActions?.onNotify?.("No worker selected.", "info");
      return;
    }

    const action = entry.actions[kind];
    if (!action.enabled) {
      this.deps?.workerActions?.onNotify?.(
        `Cannot ${kind} ${entry.worker.ticketId}: ${action.reason}.`,
        "warning",
      );
      return;
    }

    let snapshot: DashboardStatusSnapshot | undefined;
    switch (kind) {
      case "land":
        snapshot = await this.deps?.workerActions?.onLand?.(entry.worker);
        break;
      case "cancel":
        snapshot = await this.deps?.workerActions?.onCancel?.(entry.worker);
        break;
      case "cleanup":
        snapshot = await this.deps?.workerActions?.onCleanup?.(entry.worker);
        break;
    }

    this.applySnapshot(snapshot);
    this.requestRender();
  }

  handleInput(data: string): void {
    if (this.selectedTab === "issues" && this.issueExplorer?.handleInput(data)) {
      return;
    }

    if (this.selectedTab === "workers") {
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.moveWorkerSelection(-1);
        return;
      }
      if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        this.moveWorkerSelection(1);
        return;
      }
      if (matchesKey(data, "l")) {
        void this.requestWorkerAction("land");
        return;
      }
      if (matchesKey(data, "c")) {
        void this.requestWorkerAction("cancel");
        return;
      }
      if (matchesKey(data, "u")) {
        void this.requestWorkerAction("cleanup");
        return;
      }
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

    const bodyWidth = Math.max(40, width - 4);
    const repoLabel = styledAccent(
      this.theme,
      path.basename(this.model.activation.repoRoot ?? this.model.cwd) || this.model.cwd,
    );
    const modeLabel =
      this.model.state.mode === "run"
        ? styledAccent(this.theme, this.model.state.mode)
        : styledDim(this.theme, this.model.state.mode);
    const statusLine = `${repoLabel} \u00b7 ${describeActivation(this.theme, this.model.activation)} \u00b7 ${modeLabel} \u00b7 ${describeScope(this.theme, this.model.state, 22)}`;
    const secondaryParts = [
      describeCounts(this.theme, this.model.counts),
      describeWorkerSummary(this.theme, this.model.workerSummary),
      describeBackground(this.theme, this.model.state),
    ].filter((value): value is string => Boolean(value));
    const tabsLine = renderTabLine(
      this.theme,
      DASHBOARD_TABS.map((tab, index) => ({
        label: tab.label,
        selected: index === this.selectedTabIndex,
      })),
      bodyWidth,
    );
    const bodyLines =
      this.selectedTab === "issues" && this.issueExplorer
        ? this.issueExplorer.renderLines(bodyWidth, this.theme)
        : this.selectedTab === "workers" && this.model.activation.kind === "active"
          ? buildWorkerManagerPanelLines({
              workers: this.model.workers ?? [],
              state: this.model.state,
              selectedWorkerId: this.selectedWorkerEntry?.worker.workerId,
              width: bodyWidth,
              theme: this.theme,
            })
          : buildPanelLines(this.theme, this.model, this.selectedTab);

    const lines = renderSurface(this.theme, width, {
      title: "Beadwork Dashboard",
      subtitle: [statusLine, ...(secondaryParts.length > 0 ? [secondaryParts.join(" • ")] : [])],
      sections: [
        { lines: [tabsLine] },
        {
          title: DASHBOARD_TABS[this.selectedTabIndex]?.label ?? "Dashboard",
          lines: bodyLines,
        },
      ],
      footer: buildFooterHint(this.selectedTab, this.issueExplorer, this.selectedWorkerEntry),
    });

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
