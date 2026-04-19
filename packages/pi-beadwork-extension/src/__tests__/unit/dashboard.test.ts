import { describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_TABS,
  type DashboardModel,
  type DashboardStatusSnapshot,
  type DashboardTabId,
  openBeadworkDashboard,
} from "../../tui/dashboard.js";
import type { IssueExplorerDataSource } from "../../tui/issue-explorer.js";
import type {
  BeadworkIssue,
  BeadworkIssueDetail,
  SessionState,
  WorkerRuntime,
} from "../../types.js";
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
    trackedWorkerIds: overrides.trackedWorkerIds,
    workerNotices: overrides.workerNotices,
    runOptions: overrides.runOptions,
    lastRunOptions: overrides.lastRunOptions,
    recentRunSummary: overrides.recentRunSummary,
  };
}

function createWorker(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  return {
    workerId: overrides.workerId ?? "bw-101-worker",
    ticketId: overrides.ticketId ?? "BW-101",
    epicId: overrides.epicId ?? "BW-100",
    ticketTitle: overrides.ticketTitle ?? "Task",
    ticketStatus: overrides.ticketStatus ?? "open",
    branchName: overrides.branchName ?? "BW-101/task",
    worktreePath: overrides.worktreePath ?? "/tmp/worktree",
    backend: overrides.backend ?? "tmux",
    tmuxSession: overrides.tmuxSession ?? "pi-bw",
    tmuxWindow: overrides.tmuxWindow ?? "bw-101",
    tmuxPane: overrides.tmuxPane ?? "%42",
    runtimeDir: overrides.runtimeDir ?? "/tmp/runtime",
    promptFile: overrides.promptFile ?? "/tmp/runtime/handoff.txt",
    scriptFile: overrides.scriptFile ?? "/tmp/runtime/launch.sh",
    logFile: overrides.logFile ?? "/tmp/runtime/worker.log",
    stateFile: overrides.stateFile ?? "/tmp/runtime/state.txt",
    exitCodeFile: overrides.exitCodeFile ?? "/tmp/runtime/exit-code.txt",
    finishedAtFile: overrides.finishedAtFile ?? "/tmp/runtime/finished-at.txt",
    launchCommand: overrides.launchCommand ?? "bash /tmp/runtime/launch.sh",
    workerCommand: overrides.workerCommand ?? "pi",
    cleanupPolicy: overrides.cleanupPolicy ?? "keep",
    status: overrides.status ?? "running",
    startedAt: overrides.startedAt ?? "2026-04-19T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-19T00:00:01.000Z",
    ...overrides,
  };
}

function createWorkerSummary(overrides: Partial<DashboardStatusSnapshot["workerSummary"]> = {}) {
  return {
    total: overrides.total ?? 0,
    active: overrides.active ?? 0,
    launching: overrides.launching ?? 0,
    running: overrides.running ?? 0,
    exited: overrides.exited ?? 0,
    held: overrides.held ?? 0,
    landed: overrides.landed ?? 0,
    failed: overrides.failed ?? 0,
    attention: overrides.attention ?? 0,
    cleaned: overrides.cleaned ?? 0,
  };
}

function createSnapshot(overrides: Partial<DashboardStatusSnapshot> = {}): DashboardStatusSnapshot {
  return {
    activation: overrides.activation ?? { kind: "active", repoRoot: "/repo" },
    state: overrides.state ?? createState(),
    counts: overrides.counts ?? { ready: 1, blocked: 0, inProgress: 0, scopedReady: 0 },
    scopeDetail: overrides.scopeDetail,
    workerSummary: overrides.workerSummary ?? createWorkerSummary(),
    workers: overrides.workers ?? [],
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
  it("applies refreshed worker rows alongside worker summary badges", async () => {
    const runningWorker = createWorker({ status: "running", ticketTitle: "Delegable ticket" });
    const heldWorker = createWorker({
      status: "held",
      ticketTitle: "Delegable ticket",
      ticketStatus: "closed",
      validationStatus: "passed",
      landingVerification: "Validated and held. Ready to land.",
      landingAheadCount: 1,
      landingBehindCount: 0,
    });
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: "/repo",
      ui,
      sessionId: "dashboard-workers-refresh",
    });

    await openBeadworkDashboard(
      ctx,
      createModel({
        defaultTab: "workers",
        workerSummary: createWorkerSummary({ total: 1, active: 1, running: 1 }),
        workers: [runningWorker],
      }),
    );

    const dashboard = ui.customCalls[0]?.component as {
      render: (width: number) => string[];
      applySnapshot: (snapshot: DashboardStatusSnapshot) => void;
    };

    expect(renderComponent(dashboard)).toContain("Workers: total=1 active=1 held=0 landed=0");
    expect(renderComponent(dashboard)).toContain("Selected: BW-101 · running · Delegable ticket");

    dashboard.applySnapshot(
      createSnapshot({
        state: createState({ trackedWorkerIds: [heldWorker.workerId] }),
        workerSummary: createWorkerSummary({ total: 1, held: 1 }),
        workers: [heldWorker],
      }),
    );

    const rendered = renderComponent(dashboard);
    expect(rendered).toContain("Workers: total=1 active=0 held=1 landed=0");
    expect(rendered).toContain("Selected: BW-101 · held · Delegable ticket");
    expect(rendered).not.toContain("Selected: BW-101 · running · Delegable ticket");
  });

  it("applies delegate follow-up snapshots to the dashboard header, workers tab, and run tab", async () => {
    const ticket = createIssue({
      id: "BW-101",
      title: "Delegable ticket",
      parentId: "BW-100",
    });
    const ticketDetail = createDetail(ticket);
    const worker = createWorker({ ticketTitle: "Delegable ticket", status: "running" });
    const dataSource: IssueExplorerDataSource = {
      loadLevel: vi.fn().mockResolvedValue({ items: [ticket], currentDetail: undefined }),
      loadDetail: vi.fn().mockResolvedValue(ticketDetail),
    };
    const onDelegateIntent = vi.fn().mockResolvedValue(
      createSnapshot({
        state: createState({ trackedWorkerIds: [worker.workerId] }),
        counts: { ready: 0, blocked: 0, inProgress: 1, scopedReady: 0 },
        workerSummary: createWorkerSummary({ total: 1, active: 1, running: 1 }),
        workers: [worker],
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
    expect(issuesRendered).toContain("Counts: ready=0 blocked=0 in_progress=1");
    expect(issuesRendered).toContain("Workers: total=1 active=1 held=0 landed=0");

    selectTab(dashboard, "workers");
    const workersRendered = renderComponent(dashboard);
    expect(workersRendered).toContain("Selected: BW-101 · running · Delegable ticket");

    selectTab(dashboard, "run");
    const runRendered = renderComponent(dashboard);
    expect(runRendered).toContain("Run state: idle");
    expect(runRendered).toContain("Workers: total=1 active=1 held=0 landed=0 attention=0 failed=0");
  });

  it("applies run follow-up snapshots to the dashboard header, workers tab, and run tab", async () => {
    const epic = createIssue({ id: "BW-100", type: "epic", title: "Runnable epic" });
    const epicDetail = createDetail(epic, [createIssue({ id: "BW-101", parentId: "BW-100" })]);
    const worker = createWorker({ ticketTitle: "Runnable ticket", status: "running" });
    const dataSource: IssueExplorerDataSource = {
      loadLevel: vi.fn().mockResolvedValue({ items: [epic], currentDetail: undefined }),
      loadDetail: vi.fn().mockResolvedValue(epicDetail),
    };
    const onRunIntent = vi.fn().mockResolvedValue(
      createSnapshot({
        state: createState({
          mode: "run",
          scope: { kind: "epic", id: "BW-100", title: "Runnable epic" },
          runOptions: {
            workers: 2,
            until: "blocked",
            dryRun: false,
            noSpawn: false,
            maxCycles: 4,
          },
          recentRunSummary: {
            epicId: "BW-100",
            stopReason: "max-cycles",
            cycles: 1,
            launched: ["BW-101"],
            activeWorkerIds: [worker.workerId],
            workerSummary: createWorkerSummary({ total: 1, active: 1, running: 1 }),
            notes: ["cycle still active"],
            cycleSummaries: [
              {
                cycle: 1,
                ready: ["BW-101"],
                launched: ["BW-101"],
                running: [worker.workerId],
                held: [],
                landed: [],
                failed: [],
                attention: [],
                exited: [],
              },
            ],
          },
        }),
        counts: { ready: 1, blocked: 0, inProgress: 1, scopedReady: 1 },
        scopeDetail: epicDetail,
        workerSummary: createWorkerSummary({ total: 1, active: 1, running: 1 }),
        workers: [worker],
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
    expect(issuesRendered).toContain("Mode: run");
    expect(issuesRendered).toContain("Scope: epic:BW-100 · Runnable epic");
    expect(issuesRendered).toContain("Workers: total=1 active=1 held=0 landed=0");

    selectTab(dashboard, "run");
    const runRendered = renderComponent(dashboard);
    expect(runRendered).toContain("Run state: active supervision armed");
    expect(runRendered).toContain("Run scope: BW-100 · Runnable epic");
    expect(runRendered).toContain(
      "Options: workers=2 until=blocked maxCycles=4 dryRun=no noSpawn=no",
    );

    selectTab(dashboard, "workers");
    const workersRendered = renderComponent(dashboard);
    expect(workersRendered).toContain("Epic BW-100 (current scope)");
    expect(workersRendered).toContain("Selected: BW-101 · running · Runnable ticket");
  });
});
