import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../constants.js";
import {
  DASHBOARD_TABS,
  type DashboardModel,
  type DashboardStatusSnapshot,
  type DashboardTabId,
  openBeadworkDashboard,
} from "../../tui/dashboard.js";
import type { IssueExplorerDataSource } from "../../tui/issue-explorer.js";
import type { BeadworkIssue, BeadworkIssueDetail, SessionState } from "../../types.js";
import { createFakeExtensionContext, createFakeUi } from "../helpers/extension-harness.js";

function createIssue(overrides: Partial<BeadworkIssue> = {}): BeadworkIssue {
  return {
    id: overrides.id ?? "BW-100",
    title: overrides.title ?? "Example issue",
    description: overrides.description ?? "Example description",
    status: overrides.status ?? "open",
    type: overrides.type ?? "task",
    priority: overrides.priority ?? 2,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    blocks: overrides.blocks ?? [],
    assignee: overrides.assignee ?? "",
    createdAt: overrides.createdAt ?? "2026-04-19T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-19T00:00:00.000Z",
    parentId: overrides.parentId,
  };
}

function createDetail(
  overrides: Partial<BeadworkIssueDetail> = {},
  children: BeadworkIssue[] = [],
): BeadworkIssueDetail {
  return {
    ...createIssue(overrides),
    children,
  };
}

function createState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    mode: overrides.mode ?? "interactive",
    scope: overrides.scope ?? { kind: "none" },
    updatedAt: overrides.updatedAt ?? "2026-04-19T00:00:00.000Z",
    engagedAt: overrides.engagedAt,
    prime: overrides.prime,
    goal: overrides.goal,
    runInterrupted: overrides.runInterrupted,
  };
}

function createSnapshot(overrides: Partial<DashboardStatusSnapshot> = {}): DashboardStatusSnapshot {
  return {
    activation: overrides.activation ?? { kind: "active", repoRoot: "/repo" },
    state: overrides.state ?? createState(),
    counts: overrides.counts ?? { ready: 1, blocked: 0, inProgress: 0, scopedReady: 0 },
    scopeDetail: overrides.scopeDetail,
    config: overrides.config ?? DEFAULT_CONFIG,
  };
}

function createModel(overrides: Partial<DashboardModel> = {}): DashboardModel {
  return {
    ...createSnapshot(overrides),
    cwd: overrides.cwd ?? "/repo",
    defaultTab: overrides.defaultTab ?? "issues",
  };
}

async function flushAsyncWork(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

function renderComponent(component: { render: (width: number) => string[] }, width = 120): string {
  return component.render(width).join("\n");
}

function selectTab(
  component: { selectedTabIndex?: number; invalidate?: () => void },
  tab: DashboardTabId,
): void {
  component.selectedTabIndex = DASHBOARD_TABS.findIndex((entry) => entry.id === tab);
  component.invalidate?.();
}

describe("dashboard", () => {
  it("exposes issue, run, and scope tabs only", () => {
    const tabIds = DASHBOARD_TABS.map((tab) => tab.id);
    // Log tab ids so regressions show the exact dashboard surface.
    expect(tabIds).toEqual(["issues", "run", "scope"]);
    expect(tabIds).not.toContain("workers");
  });

  it("renders supplied issue data", async () => {
    const epic = createIssue({ id: "BW-100", type: "epic", title: "Dashboard epic" });
    const dataSource: IssueExplorerDataSource = {
      loadLevel: vi.fn().mockResolvedValue({ items: [epic], currentDetail: undefined }),
      loadDetail: vi.fn().mockResolvedValue(createDetail(epic)),
    };
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: "/repo",
      ui,
      sessionId: "dashboard-issue-explorer",
    });

    await openBeadworkDashboard(ctx, createModel({ defaultTab: "issues" }), {
      issueExplorer: { dataSource },
    });
    await flushAsyncWork();

    const dashboard = ui.customCalls[0]?.component as {
      render: (width: number) => string[];
    };
    const rendered = renderComponent(dashboard);
    expect(rendered).toContain("Dashboard epic");
  });

  it("updates the run pane after a run intent", async () => {
    const epic = createIssue({ id: "BW-100", type: "epic", title: "Runnable epic" });
    const epicDetail = createDetail(epic, [createIssue({ id: "BW-101", parentId: "BW-100" })]);
    const dataSource: IssueExplorerDataSource = {
      loadLevel: vi.fn().mockResolvedValue({ items: [epic], currentDetail: undefined }),
      loadDetail: vi.fn().mockResolvedValue(epicDetail),
    };
    const onRunIntent = vi.fn().mockResolvedValue(
      createSnapshot({
        state: createState({
          mode: "run",
          scope: { kind: "epic", id: "BW-100", title: "Runnable epic" },
          goal: {
            goalId: "goal-BW-100",
            scopeIds: ["BW-100"],
            reviewPolicy: "ticket",
            startedAt: "2026-04-19T00:00:00.000Z",
          },
        }),
        counts: { ready: 1, blocked: 0, inProgress: 1, scopedReady: 1 },
        scopeDetail: epicDetail,
      }),
    );
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: "/repo",
      ui,
      sessionId: "dashboard-run-refresh",
    });

    await openBeadworkDashboard(ctx, createModel({ defaultTab: "issues" }), {
      issueExplorer: {
        dataSource,
        onRunIntent,
      },
    });
    await flushAsyncWork();

    const dashboard = ui.customCalls[0]?.component as {
      handleInput: (data: string) => void;
      render: (width: number) => string[];
      selectedTabIndex?: number;
      invalidate?: () => void;
    };
    dashboard.handleInput("r");
    await flushAsyncWork();

    const issuesRendered = renderComponent(dashboard);
    expect(onRunIntent).toHaveBeenCalledWith(epicDetail);
    expect(issuesRendered).toContain(epic.title);

    selectTab(dashboard, "run");
    const runRendered = renderComponent(dashboard);
    expect(runRendered).toContain(epic.id);
    expect(runRendered).toContain(epic.title);
  });

  it("renders selected scope data", async () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: "/repo",
      ui,
      sessionId: "dashboard-scope-actions",
    });

    await openBeadworkDashboard(
      ctx,
      createModel({
        state: createState({
          scope: { kind: "epic", id: "BW-100", title: "Scoped epic" },
        }),
        scopeDetail: createDetail({ id: "BW-100", type: "epic", title: "Scoped epic" }),
      }),
    );

    const dashboard = ui.customCalls[0]?.component as {
      render: (width: number) => string[];
      selectedTabIndex?: number;
      invalidate?: () => void;
    };
    selectTab(dashboard, "scope");
    const scopeRendered = renderComponent(dashboard);
    expect(scopeRendered).toContain("BW-100");
    expect(scopeRendered).toContain("Scoped epic");
  });
});
