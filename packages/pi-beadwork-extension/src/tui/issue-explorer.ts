import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { IssueExplorerFilter, IssueExplorerLevelData } from "../actions/issues.js";
import { ISSUE_EXPLORER_FILTERS } from "../actions/issues.js";
import type { BeadworkIssue, BeadworkIssueDetail, SessionState } from "../types.js";
import { joinColumns, normalizeSurfaceLines } from "./common.js";
import type { DashboardStatusSnapshot } from "./dashboard.js";
import { renderIssueDetail, renderIssueListEntry } from "./issue-detail.js";

export type IssueExplorerBreadcrumb =
  | { kind: "repo" }
  | { kind: "epic" | "ticket"; id: string; title?: string };

export type IssueExplorerDataSource = {
  loadLevel: (input: {
    filter: IssueExplorerFilter;
    issueId?: string;
  }) => Promise<IssueExplorerLevelData>;
  loadDetail: (issueId: string) => Promise<BeadworkIssueDetail>;
};

export type IssueExplorerHooks = {
  onEngageRepoWide?: () => Promise<DashboardStatusSnapshot | undefined>;
  onScopeSelection?: (issue: BeadworkIssueDetail) => Promise<DashboardStatusSnapshot | undefined>;
  onClearScope?: () => Promise<DashboardStatusSnapshot | undefined>;
  onDelegateIntent?: (issue: BeadworkIssueDetail) => Promise<DashboardStatusSnapshot | undefined>;
  onRunIntent?: (issue: BeadworkIssueDetail) => Promise<DashboardStatusSnapshot | undefined>;
  onNotify?: (message: string, level?: "info" | "warning") => void;
};

export type IssueExplorerInput = {
  dataSource: IssueExplorerDataSource;
  initialFilter?: IssueExplorerFilter;
  initialState: SessionState;
  onChange?: () => void;
} & IssueExplorerHooks;

function describeScope(state: SessionState): string {
  if (state.scope.kind === "none") {
    return "repo-wide";
  }

  return `${state.scope.kind}:${state.scope.id}`;
}

function isEpic(issue: BeadworkIssue | BeadworkIssueDetail | undefined): boolean {
  return issue?.type === "epic";
}

function isTicket(issue: BeadworkIssue | BeadworkIssueDetail | undefined): boolean {
  return Boolean(issue && issue.type !== "epic");
}

function asBreadcrumb(issue: BeadworkIssue | BeadworkIssueDetail): IssueExplorerBreadcrumb {
  return {
    kind: issue.type === "epic" ? "epic" : "ticket",
    id: issue.id,
    title: issue.title,
  };
}

function resolveVisibleWindow(
  total: number,
  selectedIndex: number,
  maxVisible: number,
): {
  start: number;
  end: number;
  hiddenBefore: number;
  hiddenAfter: number;
} {
  if (total <= maxVisible) {
    return { start: 0, end: total, hiddenBefore: 0, hiddenAfter: 0 };
  }

  const half = Math.floor(maxVisible / 2);
  const start = Math.max(0, Math.min(selectedIndex - half, total - maxVisible));
  const end = Math.min(total, start + maxVisible);
  return {
    start,
    end,
    hiddenBefore: start,
    hiddenAfter: total - end,
  };
}

function buildSelectionHint(selected?: BeadworkIssueDetail): string {
  if (!selected) {
    return "s scope • enter drill • h back • f filter";
  }
  return [
    "enter drill",
    "h back",
    "f filter",
    "s scope",
    isEpic(selected) ? "r run epic" : "d delegate ticket",
    "x clear",
  ].join(" • ");
}
function buildCurrentLevelLines(current?: BeadworkIssueDetail): string[] {
  if (!current) {
    return ["Browsing", "repo-wide"];
  }

  return ["Browsing", `${current.id} · ${current.type} · ${current.status}`];
}

export class IssueExplorerController {
  private readonly breadcrumb: IssueExplorerBreadcrumb[] = [{ kind: "repo" }];
  private readonly filterOrder = ISSUE_EXPLORER_FILTERS;
  private readonly dataSource: IssueExplorerDataSource;
  private readonly hooks: IssueExplorerHooks;
  private readonly onChange?: () => void;
  private filter: IssueExplorerFilter;
  private sessionState: SessionState;
  private items: BeadworkIssue[] = [];
  private currentDetail?: BeadworkIssueDetail;
  private selectedDetail?: BeadworkIssueDetail;
  private selectedIndex = 0;
  private loading = false;
  private error?: string;
  private loadToken = 0;
  private detailToken = 0;

  constructor(input: IssueExplorerInput) {
    this.dataSource = input.dataSource;
    this.hooks = {
      onEngageRepoWide: input.onEngageRepoWide,
      onScopeSelection: input.onScopeSelection,
      onClearScope: input.onClearScope,
      onDelegateIntent: input.onDelegateIntent,
      onRunIntent: input.onRunIntent,
      onNotify: input.onNotify,
    };
    this.onChange = input.onChange;
    this.filter = input.initialFilter ?? "ready";
    this.sessionState = input.initialState;
  }

  get currentFilter(): IssueExplorerFilter {
    return this.filter;
  }

  get currentBreadcrumb(): IssueExplorerBreadcrumb[] {
    return [...this.breadcrumb];
  }

  get selectedIssue(): BeadworkIssue | undefined {
    return this.items[this.selectedIndex];
  }

  get selectedIssueDetail(): BeadworkIssueDetail | undefined {
    return this.selectedDetail;
  }

  get currentIssueDetail(): BeadworkIssueDetail | undefined {
    return this.currentDetail;
  }

  setSessionState(state: SessionState): void {
    this.sessionState = state;
    this.requestRender();
  }

  async initialize(): Promise<void> {
    await this.refresh(undefined);
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      void this.moveSelection(-1);
      return true;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      void this.moveSelection(1);
      return true;
    }

    if (matchesKey(data, Key.enter)) {
      void this.drillIn();
      return true;
    }

    if (matchesKey(data, Key.backspace) || matchesKey(data, "h")) {
      void this.backOut();
      return true;
    }

    if (matchesKey(data, "f")) {
      void this.cycleFilter(1);
      return true;
    }

    if (matchesKey(data, "g")) {
      void this.engageRepoWide();
      return true;
    }

    if (matchesKey(data, "s")) {
      void this.scopeSelection();
      return true;
    }

    if (matchesKey(data, "x")) {
      void this.clearScope();
      return true;
    }

    if (matchesKey(data, "d")) {
      void this.requestDelegateIntent();
      return true;
    }

    if (matchesKey(data, "r")) {
      void this.requestRunIntent();
      return true;
    }

    return false;
  }

  async cycleFilter(direction: 1 | -1 = 1): Promise<void> {
    const currentIndex = this.filterOrder.indexOf(this.filter);
    const nextIndex =
      (currentIndex + direction + this.filterOrder.length) % this.filterOrder.length;
    this.filter = this.filterOrder[nextIndex] ?? "ready";
    await this.refresh(this.selectedIssue?.id);
  }

  async moveSelection(delta: number): Promise<void> {
    if (this.items.length === 0) {
      return;
    }

    const nextIndex = Math.max(0, Math.min(this.items.length - 1, this.selectedIndex + delta));
    if (nextIndex === this.selectedIndex) {
      return;
    }

    this.selectedIndex = nextIndex;
    this.selectedDetail = undefined;
    this.requestRender();
    await this.refreshSelectedDetail();
  }

  async drillIn(): Promise<void> {
    const selected = this.selectedDetail ?? this.selectedIssue;
    if (!selected) {
      this.notify("No issue selected to drill into.", "info");
      return;
    }

    this.breadcrumb.push(asBreadcrumb(selected));
    await this.refresh(undefined);
  }

  async backOut(): Promise<void> {
    if (this.breadcrumb.length === 1) {
      this.notify("Already at repo-wide browsing.", "info");
      return;
    }

    this.breadcrumb.pop();
    await this.refresh(undefined);
  }

  async engageRepoWide(): Promise<void> {
    const snapshot = await this.hooks.onEngageRepoWide?.();
    this.applySnapshot(snapshot);
  }

  async scopeSelection(): Promise<void> {
    const selected = this.selectedDetail ?? this.selectedIssue;
    if (!selected) {
      this.notify("No issue selected to scope.", "info");
      return;
    }

    const detail = this.selectedDetail ?? (await this.dataSource.loadDetail(selected.id));
    this.selectedDetail = detail;
    const snapshot = await this.hooks.onScopeSelection?.(detail);
    this.applySnapshot(snapshot);
  }

  async clearScope(): Promise<void> {
    const snapshot = await this.hooks.onClearScope?.();
    this.applySnapshot(snapshot);
  }

  async requestDelegateIntent(): Promise<void> {
    const selected = this.selectedDetail ?? this.selectedIssue;
    if (!selected) {
      this.notify("Select a ticket before delegating.", "info");
      return;
    }

    const detail = this.selectedDetail ?? (await this.dataSource.loadDetail(selected.id));
    this.selectedDetail = detail;
    if (!isTicket(detail)) {
      this.notify("Delegate is available for tickets/tasks, not epics.", "info");
      return;
    }

    const snapshot = await this.hooks.onDelegateIntent?.(detail);
    this.applySnapshot(snapshot);
  }

  async requestRunIntent(): Promise<void> {
    const selected = this.selectedDetail ?? this.selectedIssue;
    if (!selected) {
      this.notify("Select an epic before starting a run.", "info");
      return;
    }

    const detail = this.selectedDetail ?? (await this.dataSource.loadDetail(selected.id));
    this.selectedDetail = detail;
    if (!isEpic(detail)) {
      this.notify("Run is available for epics only.", "info");
      return;
    }

    const snapshot = await this.hooks.onRunIntent?.(detail);
    this.applySnapshot(snapshot);
  }

  renderLines(width = 120): string[] {
    const contentWidth = Math.max(40, width);
    const singleColumn = contentWidth < 88;
    const leftWidth = singleColumn ? contentWidth : Math.max(34, Math.floor(contentWidth * 0.44));
    const rightWidth = singleColumn ? contentWidth : Math.max(28, contentWidth - leftWidth - 2);
    const breadcrumbLabel = this.breadcrumb
      .map((entry) => (entry.kind === "repo" ? "repo" : entry.id))
      .join(" / ");
    const headerLines = [
      `${this.filter} · ${breadcrumbLabel}`,
      `${this.sessionState.mode} · ${describeScope(this.sessionState)}${this.loading ? " · loading" : ""}`,
    ];
    if (this.error) {
      headerLines.push(`Error · ${this.error}`);
    }
    const browseLines: string[] = [
      "Issue list",
      `${this.items.length} issue${this.items.length === 1 ? "" : "s"} in view`,
      "",
    ];
    if (this.items.length === 0) {
      browseLines.push("(no issues in this view)");
    } else {
      const window = resolveVisibleWindow(this.items.length, this.selectedIndex, 6);
      if (window.hiddenBefore > 0) {
        browseLines.push(
          `↑ ${window.hiddenBefore} earlier issue${window.hiddenBefore === 1 ? "" : "s"}`,
        );
        browseLines.push("");
      }
      for (const [index, issue] of this.items.slice(window.start, window.end).entries()) {
        const absoluteIndex = window.start + index;
        browseLines.push(
          ...renderIssueListEntry(issue, {
            selected: absoluteIndex === this.selectedIndex,
            width: leftWidth,
          }),
          "",
        );
      }
      if (window.hiddenAfter > 0) {
        browseLines.push(
          `↓ ${window.hiddenAfter} later issue${window.hiddenAfter === 1 ? "" : "s"}`,
        );
      }
    }
    const selected = this.selectedDetail;
    const detailLines = [
      ...renderIssueDetail({
        issue: selected,
        heading: "Selected",
        emptyMessage: "Move to an issue to load detail.",
        width: rightWidth - 2,
      }),
      "",
      ...buildCurrentLevelLines(this.currentDetail),
    ];

    if (singleColumn) {
      return normalizeSurfaceLines(
        [...headerLines, "", ...browseLines, ...detailLines],
        contentWidth,
      );
    }
    return [
      ...headerLines,
      "",
      ...joinColumns({
        left: browseLines,
        right: detailLines,
        leftWidth,
        rightWidth,
        gap: 2,
      }),
    ];
  }
  renderFooterHint(): string {
    return `↑/↓ move • ${buildSelectionHint(this.selectedDetail)}`;
  }

  private applySnapshot(snapshot: DashboardStatusSnapshot | undefined): void {
    if (!snapshot) {
      this.requestRender();
      return;
    }

    this.sessionState = snapshot.state;
    this.requestRender();
  }

  private get currentIssueId(): string | undefined {
    const current = this.breadcrumb[this.breadcrumb.length - 1];
    return current.kind === "repo" ? undefined : current.id;
  }

  private async refresh(preserveSelectionId: string | undefined): Promise<void> {
    const token = ++this.loadToken;
    this.loading = true;
    this.error = undefined;
    this.requestRender();

    try {
      const level = await this.dataSource.loadLevel({
        filter: this.filter,
        issueId: this.currentIssueId,
      });
      if (token !== this.loadToken) {
        return;
      }

      this.currentDetail = level.currentDetail;
      this.items = level.items;
      this.selectedIndex = this.resolveSelectionIndex(preserveSelectionId);
      this.selectedDetail = undefined;
      this.loading = false;
      this.requestRender();
      await this.refreshSelectedDetail();
    } catch (error) {
      if (token !== this.loadToken) {
        return;
      }

      this.loading = false;
      this.items = [];
      this.selectedDetail = undefined;
      this.error = error instanceof Error ? error.message : String(error);
      this.notify(`Issue explorer refresh failed: ${this.error}`, "warning");
      this.requestRender();
    }
  }

  private async refreshSelectedDetail(): Promise<void> {
    const selected = this.selectedIssue;
    if (!selected) {
      this.selectedDetail = undefined;
      this.requestRender();
      return;
    }

    const token = ++this.detailToken;
    try {
      const detail = await this.dataSource.loadDetail(selected.id);
      if (token !== this.detailToken) {
        return;
      }
      this.selectedDetail = detail;
      this.requestRender();
    } catch (error) {
      if (token !== this.detailToken) {
        return;
      }
      this.error = error instanceof Error ? error.message : String(error);
      this.notify(`Failed to load issue detail for ${selected.id}: ${this.error}`, "warning");
      this.requestRender();
    }
  }

  private resolveSelectionIndex(preserveSelectionId: string | undefined): number {
    if (!preserveSelectionId) {
      return 0;
    }

    const matchIndex = this.items.findIndex((issue) => issue.id === preserveSelectionId);
    return matchIndex >= 0 ? matchIndex : 0;
  }

  private notify(message: string, level: "info" | "warning"): void {
    this.hooks.onNotify?.(message, level);
  }

  private requestRender(): void {
    this.onChange?.();
  }
}
