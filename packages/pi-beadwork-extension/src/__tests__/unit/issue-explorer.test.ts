import { describe, expect, it, vi } from "vitest";
import { createIssueExplorerDataSource, loadIssueExplorerLevel } from "../../actions/issues.js";
import type {
  BeadworkAdapter,
  BeadworkIssue,
  BeadworkIssueDetail,
  SessionState,
} from "../../index.js";
import { IssueExplorerController } from "../../tui/issue-explorer.js";

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
    mode: overrides.mode ?? "neutral",
    scope: overrides.scope ?? { kind: "none" },
    updatedAt: overrides.updatedAt ?? "2026-04-19T00:00:00.000Z",
    engagedAt: overrides.engagedAt,
    prime: overrides.prime,
    trackedWorkerIds: overrides.trackedWorkerIds,
    workerNotices: overrides.workerNotices,
    runOptions: overrides.runOptions,
  };
}

describe("issue explorer", () => {
  it("defaults to the ready filter and renders selected issue detail", async () => {
    const epic = createIssue({ id: "BW-100", type: "epic", title: "Dashboard epic" });
    const task = createIssue({ id: "BW-101", title: "Ready task", parentId: "BW-100" });
    const loadLevel = vi.fn().mockResolvedValue({
      items: [epic, task],
      currentDetail: undefined,
    });
    const loadDetail = vi
      .fn()
      .mockImplementation(async (issueId: string) =>
        issueId === "BW-100"
          ? createDetail({ ...epic, description: "Epic detail" }, [task])
          : createDetail({ ...task, description: "Task detail" }),
      );

    const controller = new IssueExplorerController({
      dataSource: { loadLevel, loadDetail },
      initialState: createState(),
    });

    await controller.initialize();

    expect(loadLevel).toHaveBeenCalledWith({ filter: "ready", issueId: undefined });
    expect(controller.currentFilter).toBe("ready");

    const rendered = controller.renderLines().join("\n");
    expect(rendered).toContain("filter=ready");
    expect(rendered).toContain("Dashboard epic");
    expect(rendered).toContain("Epic detail");
    expect(controller.renderFooterHint()).toContain("tab/shift+tab switch tabs");
  });

  it("supports filter changes and breadcrumb drill-in/out", async () => {
    const epic = createIssue({ id: "BW-100", type: "epic", title: "Scoped epic" });
    const ticket = createIssue({ id: "BW-100.1", title: "Child ticket", parentId: "BW-100" });
    const epicDetail = createDetail({ ...epic, description: "Epic body" }, [ticket]);
    const ticketDetail = createDetail({ ...ticket, description: "Ticket body" });

    const dataSource = {
      loadLevel: vi
        .fn()
        .mockImplementation(async ({ filter, issueId }: { filter: string; issueId?: string }) => {
          if (!issueId) {
            return { items: [epic], currentDetail: undefined };
          }
          if (issueId === "BW-100") {
            expect(filter).toBe("open");
            return { items: [ticket], currentDetail: epicDetail };
          }
          return { items: [], currentDetail: ticketDetail };
        }),
      loadDetail: vi.fn().mockImplementation(async (issueId: string) => {
        if (issueId === "BW-100") {
          return epicDetail;
        }
        return ticketDetail;
      }),
    };

    const controller = new IssueExplorerController({
      dataSource,
      initialState: createState(),
    });

    await controller.initialize();
    await controller.cycleFilter();
    await controller.drillIn();
    await controller.drillIn();

    expect(controller.currentFilter).toBe("open");
    expect(controller.currentBreadcrumb).toEqual([
      { kind: "repo" },
      { kind: "epic", id: "BW-100", title: "Scoped epic" },
      { kind: "ticket", id: "BW-100.1", title: "Child ticket" },
    ]);

    await controller.backOut();
    expect(controller.currentBreadcrumb).toEqual([
      { kind: "repo" },
      { kind: "epic", id: "BW-100", title: "Scoped epic" },
    ]);

    await controller.backOut();
    expect(controller.currentBreadcrumb).toEqual([{ kind: "repo" }]);
  });

  it("supports repo engage, scope retargeting, scope clearing, and launch intents", async () => {
    const epic = createIssue({ id: "BW-100", type: "epic", title: "Scoped epic" });
    const ticket = createIssue({ id: "BW-100.1", title: "Child ticket", parentId: "BW-100" });
    const epicDetail = createDetail({ ...epic, description: "Epic body" }, [ticket]);
    const ticketDetail = createDetail({ ...ticket, description: "Ticket body" });

    const onEngageRepoWide = vi.fn().mockResolvedValue({
      activation: { kind: "active", repoRoot: "/repo" },
      state: createState({ mode: "interactive", scope: { kind: "none" } }),
    });
    const onScopeSelection = vi.fn().mockResolvedValue({
      activation: { kind: "active", repoRoot: "/repo" },
      state: createState({
        mode: "interactive",
        scope: { kind: "ticket", id: "BW-100.1", title: "Child ticket" },
      }),
    });
    const onClearScope = vi.fn().mockResolvedValue({
      activation: { kind: "active", repoRoot: "/repo" },
      state: createState({ mode: "interactive", scope: { kind: "none" } }),
    });
    const onRunIntent = vi.fn().mockResolvedValue(undefined);
    const onDelegateIntent = vi.fn().mockResolvedValue(undefined);

    const controller = new IssueExplorerController({
      dataSource: {
        loadLevel: vi.fn().mockImplementation(async ({ issueId }: { issueId?: string }) => {
          if (!issueId) {
            return { items: [epic], currentDetail: undefined };
          }
          return { items: [ticket], currentDetail: epicDetail };
        }),
        loadDetail: vi
          .fn()
          .mockImplementation(async (issueId: string) =>
            issueId === "BW-100" ? epicDetail : ticketDetail,
          ),
      },
      initialState: createState(),
      onEngageRepoWide,
      onScopeSelection,
      onClearScope,
      onRunIntent,
      onDelegateIntent,
    });

    await controller.initialize();
    await controller.engageRepoWide();
    await controller.requestRunIntent();
    await controller.drillIn();
    await controller.requestDelegateIntent();
    await controller.scopeSelection();
    await controller.clearScope();

    expect(onEngageRepoWide).toHaveBeenCalledTimes(1);
    expect(onRunIntent).toHaveBeenCalledWith(epicDetail);
    expect(onDelegateIntent).toHaveBeenCalledWith(ticketDetail);
    expect(onScopeSelection).toHaveBeenCalledWith(ticketDetail);
    expect(onClearScope).toHaveBeenCalledTimes(1);

    const rendered = controller.renderLines().join("\n");
    expect(rendered).toContain("scope=repo-wide");
  });
});

describe("issue explorer data source", () => {
  it("uses bw ready for repo-wide ready browsing", async () => {
    const adapter = {
      ready: vi.fn().mockResolvedValue([createIssue({ id: "BW-100" })]),
      blocked: vi.fn(),
      list: vi.fn(),
      show: vi.fn(),
    } as unknown as BeadworkAdapter;

    const level = await loadIssueExplorerLevel({
      adapter,
      cwd: "/repo",
      filter: "ready",
    });

    expect(adapter.ready).toHaveBeenCalledWith("/repo", undefined);
    expect(level.items).toHaveLength(1);
  });

  it("loads current detail and direct children for scoped non-ready views", async () => {
    const epicDetail = createDetail({ id: "BW-100", type: "epic", title: "Epic" });
    const child = createIssue({ id: "BW-100.1", parentId: "BW-100", status: "open" });
    const adapter = {
      ready: vi.fn(),
      blocked: vi.fn(),
      list: vi.fn().mockResolvedValue([child]),
      show: vi.fn().mockResolvedValue(epicDetail),
    } as unknown as BeadworkAdapter;

    const dataSource = createIssueExplorerDataSource({ adapter, cwd: "/repo" });
    const level = await dataSource.loadLevel({ filter: "open", issueId: "BW-100" });

    expect(adapter.show).toHaveBeenCalledWith("/repo", "BW-100");
    expect(adapter.list).toHaveBeenCalledWith("/repo", {
      all: true,
      parent: "BW-100",
      status: "open",
    });
    expect(level.currentDetail?.id).toBe("BW-100");
    expect(level.items).toEqual([child]);
  });
});
