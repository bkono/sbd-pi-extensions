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

  it("renders the issue explorer without a Workers tab or land/cleanup actions", async () => {
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
    expect(rendered).toContain("ready · repo");
    expect(rendered).toContain("Dashboard epic");
    expect(rendered).toContain("● Issues");
    expect(rendered).toContain("○ Run");
    expect(rendered).toContain("○ Scope");
    expect(rendered).not.toContain("○ Workers");
    expect(rendered).not.toContain("● Workers");
    expect(rendered).not.toMatch(/\bl land\b/);
    expect(rendered).not.toMatch(/\bu cleanup\b/);
    expect(rendered).not.toContain("workers 1");
  });

  it("applies issue follow-up snapshots without a fleet table", async () => {
    const ticket = createIssue({
      id: "BW-101",
      title: "Delegable ticket",
      parentId: "BW-100",
    });
    const ticketDetail = createDetail(ticket);
    const dataSource: IssueExplorerDataSource = {
      loadLevel: vi.fn().mockResolvedValue({ items: [ticket], currentDetail: undefined }),
      loadDetail: vi.fn().mockResolvedValue(ticketDetail),
    };
    const onDelegateIntent = vi.fn().mockResolvedValue(
      createSnapshot({
        state: createState(),
        counts: { ready: 0, blocked: 0, inProgress: 1, scopedReady: 0 },
      }),
    );
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: "/repo",
      ui,
      sessionId: "dashboard-delegate-refresh",
    });

    await openBeadworkDashboard(ctx, createModel({ defaultTab: "issues" }), {
      issueExplorer: {
        dataSource,
        onDelegateIntent,
      },
    });
    await flushAsyncWork();

    const dashboard = ui.customCalls[0]?.component as {
      handleInput: (data: string) => void;
      render: (width: number) => string[];
      selectedTabIndex?: number;
      invalidate?: () => void;
    };
    dashboard.handleInput("d");
    await flushAsyncWork();

    const issuesRendered = renderComponent(dashboard);
    expect(onDelegateIntent).toHaveBeenCalledWith(ticketDetail);
    expect(issuesRendered).toContain("ready 0 · blocked 0 · in progress 1");
    expect(issuesRendered).not.toContain("workers 1 · active 1");
    expect(issuesRendered).not.toContain("○ Workers");

    selectTab(dashboard, "run");
    const runRendered = renderComponent(dashboard);
    expect(runRendered).toContain("Goal mode: inactive");
    expect(runRendered).not.toContain("Tracked workers:");
    expect(runRendered).not.toContain("Delegable ticket");
    expect(runRendered).not.toMatch(/\bl land\b/);
  });

  it("renders only current goal-mode policy with no minion rows", async () => {
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
    expect(issuesRendered).toContain("repo · active · run · epic:BW-100 · Runnable epic");
    expect(issuesRendered).not.toContain("workers 1 · active 1");
    expect(issuesRendered).toContain("run armed for BW-100");

    selectTab(dashboard, "run");
    const runRendered = renderComponent(dashboard);
    expect(runRendered).toContain("Epic: BW-100 · Runnable epic");
    expect(runRendered).toContain("Review policy: ticket");
    expect(runRendered).toContain("Goal mode: active");
    expect(runRendered).not.toContain("Tracked workers:");
    expect(runRendered).not.toContain("Runnable ticket");
    expect(runRendered).not.toContain("activeWorkers=");
    expect(runRendered).not.toContain("Workers tab");
    expect(runRendered).not.toMatch(/\bc cancel\b/);
  });

  it("does not advertise an armed run after reload of an interrupted goal", async () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: "/repo",
      ui,
      sessionId: "dashboard-interrupted-run",
    });

    await openBeadworkDashboard(
      ctx,
      createModel({
        state: createState({
          mode: "run",
          runInterrupted: true,
          scope: { kind: "epic", id: "BW-100", title: "Interrupted epic" },
          goal: {
            goalId: "goal-BW-100",
            scopeIds: ["BW-100"],
            reviewPolicy: "scope",
            startedAt: "2026-04-19T00:00:00.000Z",
          },
        }),
      }),
    );

    const dashboard = ui.customCalls[0]?.component as {
      render: (width: number) => string[];
    };
    const rendered = renderComponent(dashboard);
    expect(rendered).not.toContain("run armed");
    expect(rendered).toContain("run interrupted for BW-100");
    expect(rendered).toContain("interrupted");
  });

  it("renders the scope tab with concise dashboard-level hints", async () => {
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
    expect(scopeRendered).toContain("Current scope");
    expect(scopeRendered).toContain("interactive · epic:BW-100 · Scoped epic");
    expect(scopeRendered).not.toContain("tracked 1");
    expect(scopeRendered).toContain("Scoped epic");
    expect(scopeRendered).toContain("scope from Issues with s • clear with x");
    expect(scopeRendered).not.toContain("Quick actions");
    expect(scopeRendered).not.toContain("○ Workers");
  });
});
