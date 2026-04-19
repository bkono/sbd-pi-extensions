import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type {
  ActivationState,
  BeadworkCounts,
  BeadworkIssueDetail,
  SessionState,
  WorkerSummary,
} from "../types.js";

export type DashboardTabId = "issues" | "workers" | "run" | "scope" | "actions";

export type DashboardStatusSnapshot = {
  activation: ActivationState;
  state: SessionState;
  counts?: BeadworkCounts;
  scopeDetail?: BeadworkIssueDetail;
  workerSummary?: WorkerSummary;
};

export type DashboardModel = DashboardStatusSnapshot & {
  cwd: string;
  defaultTab?: DashboardTabId;
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

function buildPanelLines(model: DashboardModel, tab: DashboardTabId): string[] {
  switch (tab) {
    case "issues": {
      if (model.activation.kind === "available") {
        return [
          "This repo looks beadwork-capable, but the beadwork branch is not initialized yet.",
          model.activation.detail ?? "Future onboarding/status content will live here.",
          "",
          "Later tickets will replace this shell with the issue explorer.",
        ];
      }

      const ready = model.counts?.ready ?? 0;
      const blocked = model.counts?.blocked ?? 0;
      const scopedReady = model.counts?.scopedReady;
      return [
        "Ready-first issue explorer scaffold.",
        `Ready now: ${ready}`,
        `Blocked now: ${blocked}`,
        scopedReady !== undefined ? `Scoped ready: ${scopedReady}` : "Scope: repo-wide browsing",
        "",
        "Later tickets will add breadcrumb drill-in, filters, and direct scope/run/delegate actions.",
      ];
    }
    case "workers": {
      const summary = model.workerSummary;
      return [
        "Worker manager scaffold.",
        summary
          ? `Workers: total=${summary.total} active=${summary.active} held=${summary.held} landed=${summary.landed} attention=${summary.attention} failed=${summary.failed}`
          : "Workers: none tracked in this session yet.",
        "",
        "Later tickets will add grouped worker detail, landing, cancel, and cleanup controls.",
      ];
    }
    case "run":
      return [
        "Run manager scaffold.",
        model.state.mode === "run"
          ? `Active run scope: ${describeScope(model.state)}`
          : "No active supervised run in this session.",
        model.state.runOptions
          ? `Current options: workers=${model.state.runOptions.workers} until=${model.state.runOptions.until} noSpawn=${model.state.runOptions.noSpawn ? "yes" : "no"}`
          : "Run options will appear here when a session run is active.",
        "",
        "Later tickets will add cycle summaries and launch/pause controls.",
      ];
    case "scope":
      return [
        "Scope/session scaffold.",
        `Mode: ${model.state.mode}`,
        `Scope: ${describeScope(model.state)}`,
        model.scopeDetail
          ? `Scoped issue: ${model.scopeDetail.id} · ${model.scopeDetail.type} · ${model.scopeDetail.status}`
          : "No scoped issue loaded.",
        "",
        "Later tickets will add retarget/clear flows directly in this tab.",
      ];
    case "actions":
      return [
        "Operator actions scaffold.",
        "Available now:",
        "- /bw:status",
        "- /bw:scope",
        "- /bw:workers",
        "- /bw:delegate",
        "- /bw:land",
        "- /bw:cancel",
        "- /bw:cleanup",
        "- /bw:run",
        "",
        "Later tickets will wire these actions directly to issue and worker selections.",
      ];
  }
}

class DashboardComponent implements Component {
  private selectedTabIndex = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly model: DashboardModel,
    private readonly done: (result: undefined) => void,
  ) {
    const initialIndex = DASHBOARD_TABS.findIndex((tab) => tab.id === model.defaultTab);
    this.selectedTabIndex = initialIndex >= 0 ? initialIndex : 0;
  }

  private get selectedTab(): DashboardTabId {
    return DASHBOARD_TABS[this.selectedTabIndex]?.id ?? "issues";
  }

  private requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
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

    const bodyLines = buildPanelLines(this.model, this.selectedTab);
    const footer = this.theme.fg(
      "dim",
      "tab/shift+tab or ←/→ switch tabs • esc closes • later tickets fill the panes",
    );

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
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new DashboardComponent(tui, theme, model, done),
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
