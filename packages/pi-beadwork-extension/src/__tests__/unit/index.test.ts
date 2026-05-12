import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import beadworkExtension from "../../index.js";
import {
  loadWorkerRegistry,
  resolveWorkerRegistryPath,
  saveWorkerRegistry,
} from "../../registry.js";
import { loadSessionState, resolveSessionStateDir, saveSessionState } from "../../session-state.js";
import type { WorkerRuntime } from "../../types.js";
import {
  createExtensionTestHarness,
  createFakeExtensionContext,
  createFakeUi,
} from "../helpers/extension-harness.js";

const {
  detectActivationMock,
  adapterMock,
  createBeadworkAdapterMock,
  runBoundedEpicLoopMock,
  launchTicketWorkerMock,
  requestWorkerLandingMock,
  inspectWorkerRuntimeMock,
} = vi.hoisted(() => ({
  detectActivationMock: vi.fn(),
  adapterMock: {
    prime: vi.fn(),
    ready: vi.fn(),
    blocked: vi.fn(),
    list: vi.fn(),
    show: vi.fn(),
    history: vi.fn(),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    comment: vi.fn(),
    label: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    reopen: vi.fn(),
    defer: vi.fn(),
    undefer: vi.fn(),
    sync: vi.fn(),
    getCounts: vi.fn(),
  },
  createBeadworkAdapterMock: vi.fn(),
  runBoundedEpicLoopMock: vi.fn(),
  launchTicketWorkerMock: vi.fn(),
  inspectWorkerRuntimeMock: vi.fn(),
  requestWorkerLandingMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  Type: {
    Object: (value: unknown) => value,
    Optional: (value: unknown) => value,
    String: (value: unknown) => value,
    Boolean: (value: unknown) => value,
    Number: (value: unknown) => value,
  },
}));

vi.mock("../../activation.js", () => ({
  detectActivation: detectActivationMock,
}));

vi.mock("../../bw.js", () => ({
  createBeadworkAdapter: createBeadworkAdapterMock,
}));

vi.mock("../../orchestrator.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../orchestrator.js")>("../../orchestrator.js");

  return {
    ...actual,
    runBoundedEpicLoop: runBoundedEpicLoopMock,
    launchTicketWorker: launchTicketWorkerMock,
    requestWorkerLanding: requestWorkerLandingMock,
    inspectWorkerRuntime: (input: Parameters<typeof actual.inspectWorkerRuntime>[0]) => {
      const implementation = inspectWorkerRuntimeMock.getMockImplementation();
      return implementation ? implementation(input) : actual.inspectWorkerRuntime(input);
    },
  };
});

function createRunSummary(
  stopReason: "completed" | "blocked" | "empty" | "max-cycles" | "attention",
) {
  return {
    epicId: "BW-100",
    stopReason,
    cycles: 1,
    launched: [],
    activeWorkerIds: [],
    workerSummary: {
      total: 0,
      active: 0,
      launching: 0,
      running: 0,
      exited: 0,
      held: 0,
      landed: 0,
      verified: 0,
      successfulTerminal: 0,
      failed: 0,
      attention: 0,
      cleaned: 0,
    },
    notes: [],
    cycleSummaries: [],
  };
}

function createWorkerRuntime(tempDir: string) {
  const runtimeDir = path.join(tempDir, ".pi", "beadwork", "workers", "runtime", "bw-101-worker");
  return {
    workerId: "bw-101-worker",
    ticketId: "BW-101",
    epicId: "BW-100",
    ticketTitle: "Task",
    ticketStatus: "open",
    executionMode: "worktree",
    checkoutPath: path.join(tempDir, "worktree"),
    branchName: "BW-101/task",
    worktreePath: path.join(tempDir, "worktree"),
    backend: "tmux" as const,
    tmuxSession: "pi-bw",
    tmuxWindow: "bw-101",
    tmuxPane: "pending",
    runtimeDir,
    promptFile: path.join(runtimeDir, "handoff.txt"),
    scriptFile: path.join(runtimeDir, "launch.sh"),
    logFile: path.join(runtimeDir, "worker.log"),
    stateFile: path.join(runtimeDir, "state.txt"),
    exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
    finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
    launchCommand: `bash ${path.join(runtimeDir, "launch.sh")}`,
    workerCommand: "pi",
    cleanupPolicy: "keep" as const,
    status: "launching" as const,
    startedAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:01.000Z",
  };
}

describe("pi beadwork extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    createBeadworkAdapterMock.mockReturnValue(adapterMock);
    adapterMock.prime.mockResolvedValue("prime guidance");
    launchTicketWorkerMock.mockReset();
    requestWorkerLandingMock.mockReset();
    adapterMock.ready.mockResolvedValue([]);
    adapterMock.blocked.mockResolvedValue([]);
    adapterMock.list.mockResolvedValue([]);
    adapterMock.show.mockResolvedValue({
      id: "BW-100",
      title: "Scoped epic",
      description: "description",
      status: "open",
      type: "epic",
      priority: 2,
      labels: [],
      blockedBy: [],
      blocks: [],
      assignee: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
      children: [],
    });
    adapterMock.history.mockResolvedValue([]);
    adapterMock.createIssue.mockResolvedValue({
      issue: {
        id: "BW-101",
        title: "Created task",
        description: "",
        status: "open",
        type: "task",
        priority: 2,
        labels: [],
        blockedBy: [],
        blocks: [],
        assignee: "",
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    });
    adapterMock.updateIssue.mockResolvedValue({
      id: "BW-100",
      title: "Scoped epic",
      description: "description",
      status: "open",
      type: "epic",
      priority: 2,
      labels: [],
      blockedBy: [],
      blocks: [],
      assignee: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    });
    adapterMock.comment.mockResolvedValue({
      id: "BW-100",
      title: "Scoped epic",
      description: "description",
      status: "open",
      type: "epic",
      priority: 2,
      labels: [],
      blockedBy: [],
      blocks: [],
      assignee: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    });
    adapterMock.label.mockResolvedValue({
      id: "BW-100",
      title: "Scoped epic",
      description: "description",
      status: "open",
      type: "epic",
      priority: 2,
      labels: [],
      blockedBy: [],
      blocks: [],
      assignee: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    });
    adapterMock.reopen.mockResolvedValue({
      id: "BW-100",
      title: "Scoped epic",
      description: "description",
      status: "open",
      type: "epic",
      priority: 2,
      labels: [],
      blockedBy: [],
      blocks: [],
      assignee: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    });
    adapterMock.defer.mockResolvedValue({
      id: "BW-100",
      title: "Scoped epic",
      description: "description",
      status: "deferred",
      type: "epic",
      priority: 2,
      labels: [],
      blockedBy: [],
      blocks: [],
      assignee: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    });
    adapterMock.undefer.mockResolvedValue({
      id: "BW-100",
      title: "Scoped epic",
      description: "description",
      status: "open",
      type: "epic",
      priority: 2,
      labels: [],
      blockedBy: [],
      blocks: [],
      assignee: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    });
    adapterMock.getCounts.mockResolvedValue({
      ready: 2,
      blocked: 1,
      inProgress: 1,
      scopedReady: 1,
    });
    runBoundedEpicLoopMock.mockResolvedValue(createRunSummary("blocked"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    delete process.env.PI_BEADWORK_WORKER_ID;
    delete process.env.PI_BEADWORK_TICKET_ID;
    delete process.env.PI_BEADWORK_WORKER_REGISTRY_FILE;
    delete process.env.PI_BEADWORK_WORKER_SELF_REVIEW_ENABLED;
  });

  it("registers the /bw command", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    expect(harness.commands.has("bw")).toBe(true);
  });

  it("registers the planned /bw:* alias commands", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);

    expect(harness.commands.has("bw:status")).toBe(true);
    expect(harness.commands.has("bw:ready")).toBe(true);
    expect(harness.commands.has("bw:list")).toBe(true);
    expect(harness.commands.has("bw:show")).toBe(true);
    expect(harness.commands.has("bw:scope")).toBe(true);
    expect(harness.commands.has("bw:workers")).toBe(true);
    expect(harness.commands.has("bw:delegate")).toBe(true);
    expect(harness.commands.has("bw:land")).toBe(true);
    expect(harness.commands.has("bw:cancel")).toBe(true);
    expect(harness.commands.has("bw:cleanup")).toBe(true);
    expect(harness.commands.has("bw:run")).toBe(true);
    expect(harness.commands.has("bw:off")).toBe(true);
    expect(harness.commands.has("bw:adopt")).toBe(true);
  });

  it("registers beadwork_delegate tool with mode-neutral ticket wording", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const delegateTool = harness.tools.get("beadwork_delegate");

    expect(delegateTool?.parameters).toMatchObject({
      ticket_id: { description: "Ticket id to launch as a worker." },
    });
    expect(JSON.stringify(delegateTool?.parameters)).not.toContain("in a worktree");
  });

  it("registers beadwork_land_worker tool with mode-aware follow-up wording", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const landTool = harness.tools.get("beadwork_land_worker");

    expect(landTool?.description).toContain("merge back held worktree workers");
    expect(landTool?.description).toContain("rerun current-branch verification");
    expect(landTool?.description).not.toContain("Request explicit merge-back");
    expect(landTool?.parameters).toMatchObject({
      ticket_id: {
        description:
          "Ticket id to process through explicit follow-up (worktree landing/merge-back or current-branch verification/retry).",
      },
      worker_id: {
        description:
          "Worker id to process through explicit follow-up (worktree landing/merge-back or current-branch verification/retry).",
      },
    });
    expect(JSON.stringify(landTool?.parameters)).not.toContain("Ticket id to land");
    expect(JSON.stringify(landTool?.parameters)).not.toContain("Worker id to land");
  });

  it("registers beadwork_worker_done as the terminal worker protocol tool", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const doneTool = harness.tools.get("beadwork_worker_done");

    expect(doneTool?.description).toContain("same-session self-review");
    expect(doneTool?.parameters).toMatchObject({
      ticket_id: { description: "Ticket id this worker completed." },
      self_review_completed: {
        description: "Set true after completing the requested self-review pass.",
      },
    });
  });

  it("asks the same worker for self-review on the first done call", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-worker-done-"));
    const registryPath = resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json");
    const worker = createWorkerRuntime(tempDir) as WorkerRuntime;
    await saveWorkerRegistry(registryPath, [
      { ...worker, status: "running", selfReviewStatus: "pending" },
    ]);
    process.env.PI_BEADWORK_WORKER_ID = worker.workerId;
    process.env.PI_BEADWORK_TICKET_ID = worker.ticketId;
    process.env.PI_BEADWORK_WORKER_REGISTRY_FILE = registryPath;
    process.env.PI_BEADWORK_WORKER_SELF_REVIEW_ENABLED = "1";

    const tool = harness.tools.get("beadwork_worker_done") as {
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown,
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const ctx = createFakeExtensionContext({ cwd: tempDir });

    const result = await tool.execute(
      "tool-call",
      { ticket_id: worker.ticketId, summary: "implemented" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0]?.text).toContain("one focused self-review pass");
    expect(result.content[0]?.text).toContain("self_review_completed: true");
    expect(result.details.action).toBe("self-review-requested");
    expect(adapterMock.close).not.toHaveBeenCalled();
    expect(adapterMock.sync).not.toHaveBeenCalled();

    const [updated] = await loadWorkerRegistry(registryPath);
    expect(updated?.selfReviewStatus).toBe("requested");
    expect(updated?.selfReviewSummary).toBe("implemented");
  });

  it("closes, syncs, and shuts down on the final worker done call", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-worker-done-"));
    const registryPath = resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json");
    const worker = createWorkerRuntime(tempDir) as WorkerRuntime;
    await saveWorkerRegistry(registryPath, [
      { ...worker, status: "running", selfReviewStatus: "requested" },
    ]);
    process.env.PI_BEADWORK_WORKER_ID = worker.workerId;
    process.env.PI_BEADWORK_TICKET_ID = worker.ticketId;
    process.env.PI_BEADWORK_WORKER_REGISTRY_FILE = registryPath;
    process.env.PI_BEADWORK_WORKER_SELF_REVIEW_ENABLED = "1";

    const shutdown = vi.fn();
    const ctx = createFakeExtensionContext({ cwd: tempDir }) as ReturnType<
      typeof createFakeExtensionContext
    > & { shutdown: () => void };
    ctx.shutdown = shutdown;
    const tool = harness.tools.get("beadwork_worker_done") as {
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown,
      ) => Promise<{ terminate?: boolean; details: Record<string, unknown> }>;
    };

    const result = await tool.execute(
      "tool-call",
      { ticket_id: worker.ticketId, summary: "self-reviewed", self_review_completed: true },
      undefined,
      undefined,
      ctx,
    );

    expect(adapterMock.close).toHaveBeenCalledWith(tempDir, worker.ticketId, "self-reviewed");
    expect(adapterMock.sync).toHaveBeenCalledWith(tempDir);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(result.terminate).toBe(true);
    expect(result.details.action).toBe("completion-accepted");

    const [updated] = await loadWorkerRegistry(registryPath);
    expect(updated?.selfReviewStatus).toBe("completed");
    expect(updated?.selfReviewSummary).toBe("self-reviewed");
  });

  it("opens the dashboard from bare /bw in a neutral active session", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-dashboard" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    await harness.invokeCommand("bw", "", ctx);

    expect(ui.customCalls).toHaveLength(1);
    expect(ui.notifications).toHaveLength(0);
  });

  it("opens the issues tab with the ready-first explorer by default", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-dashboard-issues",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    adapterMock.ready.mockResolvedValue([
      {
        id: "BW-100",
        title: "Scoped epic",
        description: "description",
        status: "open",
        type: "epic",
        priority: 2,
        labels: [],
        blockedBy: [],
        blocks: [],
        assignee: "",
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    ]);

    await harness.invokeCommand("bw", "", ctx);
    await Promise.resolve();
    await Promise.resolve();

    const component = ui.customCalls[0]?.component as
      | { render: (width: number) => string[] }
      | undefined;
    const rendered = component?.render(100).join("\n") ?? "";

    expect(rendered).toContain("ready · repo");
    expect(rendered).toContain("Scoped epic");
  });

  it("opens the delegate clarify modal from the issue explorer", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-dashboard-delegate-modal",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    adapterMock.ready.mockResolvedValue([
      {
        id: "BW-101",
        title: "Delegable ticket",
        description: "description",
        status: "open",
        type: "task",
        priority: 2,
        labels: [],
        blockedBy: [],
        blocks: [],
        assignee: "",
        parentId: "BW-100",
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    ]);
    adapterMock.show.mockResolvedValue({
      id: "BW-101",
      title: "Delegable ticket",
      description: "description",
      status: "open",
      type: "task",
      priority: 2,
      labels: [],
      blockedBy: [],
      blocks: [],
      assignee: "",
      parentId: "BW-100",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
      children: [],
    });

    await harness.invokeCommand("bw", "", ctx);
    await Promise.resolve();
    await Promise.resolve();

    const dashboard = ui.customCalls[0]?.component as
      | { handleInput: (data: string) => void }
      | undefined;
    dashboard?.handleInput("d");
    await Promise.resolve();
    await Promise.resolve();

    const modal = ui.customCalls[1]?.component as
      | { render: (width: number) => string[] }
      | undefined;
    const rendered = modal?.render(80).join("\n") ?? "";
    expect(ui.customCalls).toHaveLength(2);
    expect(rendered).toContain("Delegate ticket");
    expect(rendered).toContain("BW-101 · Delegable ticket");
  });

  it("opens the run clarify modal from the issue explorer", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-dashboard-run-modal",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    adapterMock.ready.mockResolvedValue([
      {
        id: "BW-100",
        title: "Runnable epic",
        description: "description",
        status: "open",
        type: "epic",
        priority: 2,
        labels: [],
        blockedBy: [],
        blocks: [],
        assignee: "",
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    ]);
    adapterMock.show.mockResolvedValue({
      id: "BW-100",
      title: "Runnable epic",
      description: "description",
      status: "open",
      type: "epic",
      priority: 2,
      labels: [],
      blockedBy: [],
      blocks: [],
      assignee: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
      children: [],
    });

    await harness.invokeCommand("bw", "", ctx);
    await Promise.resolve();
    await Promise.resolve();

    const dashboard = ui.customCalls[0]?.component as
      | { handleInput: (data: string) => void }
      | undefined;
    dashboard?.handleInput("r");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const modal = ui.customCalls[1]?.component as
      | { render: (width: number) => string[] }
      | undefined;
    const rendered = modal?.render(80).join("\n") ?? "";
    expect(ui.customCalls).toHaveLength(2);
    expect(rendered).toContain("Run epic");
    expect(rendered).toContain("BW-100 · Runnable epic");
  });

  it("opens the dashboard from bare /bw when beadwork is available but not initialized", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-dashboard-available",
    });

    detectActivationMock.mockResolvedValue({
      kind: "available",
      reason: "repo-not-initialized",
      repoRoot: tempDir,
      detail: "Local `beadwork` branch was not found in this repository.",
    });

    await harness.invokeCommand("bw", "", ctx);

    expect(ui.customCalls).toHaveLength(1);
  });

  it("falls back to text status for bare /bw when beadwork is unavailable", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-dashboard-fallback",
    });

    detectActivationMock.mockResolvedValue({
      kind: "inactive",
      reason: "no-git",
      detail: "Current working directory is not inside a git repository.",
    });

    await harness.invokeCommand("bw", "", ctx);

    expect(ui.customCalls).toHaveLength(0);
    expect(ui.notifications.at(-1)?.message).toContain("Activation: inactive · no-git");
  });

  it("exposes subcommand completions on /bw", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);

    const items = (await harness.getCommandCompletions("bw", "de")) as Array<{ value: string }>;
    expect(items.map((item) => item.value)).toContain("delegate");
    expect(items.map((item) => item.value)).not.toContain("run");
  });

  it("updates the statusline on session start", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui });

    detectActivationMock.mockResolvedValue({
      kind: "available",
      reason: "repo-not-initialized",
      repoRoot: tempDir,
    });

    await harness.dispatch("session_start", { reason: "startup" }, ctx);

    expect(ui.statuses.get("beadwork")).toBeUndefined();
  });

  it("shows activation, mode, and counts via /bw status", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-status" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    await harness.invokeCommand("bw", "status", ctx);

    expect(ui.notifications[0].message).toContain("Activation: active");
    expect(ui.notifications[0].message).toContain("Mode: neutral");
    expect(ui.notifications[0].message).toContain("Counts: ready=2 blocked=1 in_progress=1");
    expect(ui.statuses.get("beadwork")).toContain("bw neutral");
  });

  it("lists issues with explicit filters via /bw list", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-list" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    adapterMock.list.mockResolvedValue([
      {
        id: "BW-100.1",
        title: "Child task",
        description: "",
        status: "open",
        type: "task",
        priority: 2,
        labels: [],
        blockedBy: [],
        blocks: [],
        assignee: "",
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
        parentId: "BW-100",
      },
    ]);

    await harness.invokeCommand("bw", "list --all --parent BW-100", ctx);

    expect(adapterMock.list).toHaveBeenCalledWith(
      tempDir,
      expect.objectContaining({
        all: true,
        parent: "BW-100",
      }),
    );
    expect(ui.notifications.at(-1)?.message).toContain("Issue list:");
    expect(ui.notifications.at(-1)?.message).toContain("BW-100.1");
  });

  it("supports issue depth reassignment via /bw update --clear-parent", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-update" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    await harness.invokeCommand("bw", "update BW-100.1 --clear-parent --status open", ctx);

    expect(adapterMock.updateIssue).toHaveBeenCalledWith(
      tempDir,
      "BW-100.1",
      expect.objectContaining({
        parentId: null,
        status: "open",
      }),
    );
    expect(ui.notifications.at(-1)?.message).toContain("Updated: BW-100");
  });

  it("supports dependency removal via /bw dep remove", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-dep-remove" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    await harness.invokeCommand("bw", "dep remove BW-200 blocks BW-300", ctx);

    expect(adapterMock.removeDependency).toHaveBeenCalledWith(tempDir, "BW-200", "BW-300");
    expect(ui.notifications.at(-1)?.message).toContain("Dependency removed");
  });

  it("shows issue history via /bw history", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-history" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    adapterMock.history.mockResolvedValue([
      {
        timestamp: "2026-04-15 12:00",
        author: "beadwork",
        intent: "update BW-100.1 --parent BW-100",
      },
    ]);

    await harness.invokeCommand("bw", "history BW-100.1 --limit 1", ctx);

    expect(adapterMock.history).toHaveBeenCalledWith(tempDir, "BW-100.1", 1);
    expect(ui.notifications.at(-1)?.message).toContain("History for BW-100.1");
  });

  it("engages interactive mode, caches prime, and scopes the session", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-engage" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    await harness.invokeCommand("bw", "engage BW-100", ctx);

    const stateDir = resolveSessionStateDir(tempDir, ".pi/beadwork/session-state");
    const persisted = await loadSessionState(stateDir, "session-engage");
    expect(persisted.mode).toBe("interactive");
    expect(persisted.scope).toEqual({ kind: "epic", id: "BW-100", title: "Scoped epic" });
    expect(persisted.prime?.content).toBe("prime guidance");
    expect(ui.notifications.at(-2)?.message).toContain("interactive mode engaged");
    expect(ui.notifications.at(-1)?.message).toContain("Scope: epic:BW-100");
  });

  it("injects beadwork context into the system prompt when engaged", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-prompt" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    await harness.invokeCommand("bw", "engage BW-100", ctx);
    const result = await harness.dispatch<{ systemPrompt?: string }>(
      "before_agent_start",
      { systemPrompt: "Base prompt" },
      ctx,
    );

    expect(result?.systemPrompt).toContain("Base prompt");
    expect(result?.systemPrompt).toContain("[BEADWORK SESSION ACTIVE]");
    expect(result?.systemPrompt).toContain("prime guidance");
    expect(result?.systemPrompt).toContain("Scoped issue");
  });

  it("previews /bw adopt from an explicit markdown file source", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-adopt-preview",
    });

    const planPath = path.join(tempDir, "proposal.md");
    await writeFile(
      planPath,
      ["# Proposal", "", "## Scope", "- Replace parser heuristics", "- Keep review step"].join(
        "\n",
      ),
      "utf8",
    );

    await harness.invokeCommand("bw", "adopt --file proposal.md", ctx);

    const message = ui.notifications.at(-1)?.message ?? "";
    expect(message).toContain(`Plan source: file:${planPath}`);
    expect(message).toContain("Source excerpt:");
    expect(message).toContain("# Proposal");
    expect(message).toContain("Run again with --apply to create beadwork artifacts.");
  });

  it("warns when /bw adopt receives an empty markdown file", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-adopt-empty-file",
    });

    await writeFile(path.join(tempDir, "proposal.md"), "\n   \n", "utf8");

    await harness.invokeCommand("bw", "adopt --file proposal.md", ctx);

    expect(ui.notifications.at(-1)?.level).toBe("warning");
    expect(ui.notifications.at(-1)?.message).toContain("No markdown content found");
  });

  it("queues an LLM-guided decomposition turn for /bw adopt --land multi --apply", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-adopt-multi-apply",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    await writeFile(
      path.join(tempDir, "proposal.md"),
      "# Proposal\n\n## Scope\n- parser\n- command wiring\n- tests\n",
      "utf8",
    );

    await harness.invokeCommand("bw", "adopt --file proposal.md --land multi --apply", ctx);

    expect(adapterMock.createIssue).not.toHaveBeenCalled();
    expect(harness.sentUserMessages).toHaveLength(1);
    const queuedPrompt = String(harness.sentUserMessages[0]?.content ?? "");
    expect(queuedPrompt).toContain("/bw adopt in multi-step mode");
    expect(queuedPrompt).toContain("beadwork_create_issue");
    expect(queuedPrompt).toContain("beadwork_add_dependency");
    expect(queuedPrompt).toContain("file-surface areas");

    const message = ui.notifications.at(-1)?.message ?? "";
    expect(message).toContain("Queued an LLM-guided decomposition turn");
  });

  it("shows worker diagnostics with landing, cleanup, and follow-up details", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-workers" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    const worker = {
      ...createWorkerRuntime(tempDir),
      status: "landed" as const,
      ticketStatus: "closed",
      validationStatus: "passed" as const,
      validationSummary: "Validation passed: npm run lint, npm run test, npm run typecheck.",
      cleanupPolicy: "cleanup-after-landing" as const,
      cleanupStatus: "cleaned" as const,
      landingVerifiedAt: "2026-04-14T01:00:00.000Z",
      landingAheadCount: 0,
      landingBehindCount: 3,
      landingVerification:
        "Landing verified: worktree is clean and worker HEAD is fully contained in repo HEAD.",
    };
    await saveWorkerRegistry(
      resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json"),
      [worker],
    );

    await harness.invokeCommand("bw", "workers BW-100", ctx);

    const message = ui.notifications.at(-1)?.message ?? "";
    expect(message).toContain("Workers for BW-100:");
    expect(message).toContain("Summary: total=1");
    expect(message).toContain("landing:verified");
    expect(message).toContain("cleanup:cleaned");
    expect(message).toContain("Next: No action needed.");
  });

  it("opens the worker manager overlay from /bw:workers", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-workers-overlay",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    const worker = {
      ...createWorkerRuntime(tempDir),
      status: "held" as const,
      ticketStatus: "closed",
      validationStatus: "passed" as const,
      landingAheadCount: 2,
      landingBehindCount: 0,
      landingVerification: "Validated and held. Ready to land.",
    };
    await saveWorkerRegistry(
      resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json"),
      [worker],
    );

    await harness.invokeCommand("bw:workers", "", ctx);

    expect(ui.customCalls).toHaveLength(1);
    expect(ui.notifications.at(-1)?.message ?? "").not.toContain("No beadwork workers");
  });

  it("does not say landed cleanly when validation is still pending", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-worker-pending-validation",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    await mkdir(path.join(tempDir, ".pi"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".pi", "beadwork-config.json"),
      `${JSON.stringify({ landing: { validateCommands: [] } }, null, 2)}\n`,
      "utf8",
    );

    const worker = {
      ...createWorkerRuntime(tempDir),
      status: "landed" as const,
      ticketStatus: "closed",
      cleanupPolicy: "keep" as const,
      validationStatus: "pending" as const,
      landingVerifiedAt: "2026-04-14T01:00:00.000Z",
      landingAheadCount: 0,
      landingBehindCount: 1,
      landingVerification:
        "Landing verified: worktree is clean and worker HEAD is fully contained in repo HEAD.",
    };
    await saveWorkerRegistry(
      resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json"),
      [worker],
    );

    const stateDir = resolveSessionStateDir(tempDir, ".pi/beadwork/session-state");
    await saveSessionState(stateDir, "session-worker-pending-validation", {
      mode: "neutral",
      scope: { kind: "none" },
      updatedAt: "2026-04-14T00:00:00.000Z",
      trackedWorkerIds: [worker.workerId],
    });

    await harness.dispatch("turn_end", { reason: "assistant" }, ctx);

    const message = ui.notifications.at(-1)?.message ?? "";
    expect(message).toContain("appears integrated, but validation is still pending");
    expect(message).not.toContain("landed cleanly");
  });

  it("uses execution-mode-specific wording in worker supervision notices", async () => {
    inspectWorkerRuntimeMock.mockImplementation(async (input) => input.worker);

    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const registryPath = resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json");
    const stateDir = resolveSessionStateDir(tempDir, ".pi/beadwork/session-state");

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    const currentWorker = (workerId: string, overrides: Partial<WorkerRuntime>): WorkerRuntime => {
      const {
        cleanupPolicy: _cleanupPolicy,
        worktreePath: _worktreePath,
        ...worker
      } = createWorkerRuntime(tempDir);

      return {
        ...worker,
        workerId,
        ticketId: `BW-${workerId}`,
        executionMode: "current-branch",
        checkoutPath: tempDir,
        branchName: "main",
        launchHead: "abc123",
        ...overrides,
      } as WorkerRuntime;
    };

    const worktreeWorker = (workerId: string, overrides: Partial<WorkerRuntime>): WorkerRuntime =>
      ({
        ...createWorkerRuntime(tempDir),
        workerId,
        ticketId: `BW-${workerId}`,
        ...overrides,
      }) as WorkerRuntime;

    async function noticeFor(worker: WorkerRuntime): Promise<string> {
      const sessionId = `session-${worker.workerId}`;
      const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId });
      const before = ui.notifications.length;

      await saveWorkerRegistry(registryPath, [worker]);
      await saveSessionState(stateDir, sessionId, {
        mode: "neutral",
        scope: { kind: "none" },
        updatedAt: "2026-04-14T00:00:00.000Z",
        trackedWorkerIds: [worker.workerId],
      });

      await harness.dispatch("turn_end", { reason: "assistant" }, ctx);

      return ui.notifications.slice(before).at(-1)?.message ?? "";
    }

    const currentValidation = await noticeFor(
      currentWorker("current-validation", {
        status: "running",
        remediationStatus: "running",
        validationStatus: "failed",
      }),
    );
    expect(currentValidation).toContain("running in the current checkout");
    expect(currentValidation).not.toContain("existing worktree");

    const worktreeValidation = await noticeFor(
      worktreeWorker("worktree-validation", {
        status: "running",
        remediationStatus: "running",
        validationStatus: "failed",
      }),
    );
    expect(worktreeValidation).toContain("running in the existing worktree");

    const currentReview = await noticeFor(
      currentWorker("current-review", {
        status: "running",
        reviewStatus: "remediation-in-progress",
      }),
    );
    expect(currentReview).toContain("before current-branch verification");
    expect(currentReview).not.toContain("before merge-back");

    const worktreeReview = await noticeFor(
      worktreeWorker("worktree-review", {
        status: "running",
        reviewStatus: "remediation-in-progress",
      }),
    );
    expect(worktreeReview).toContain("before merge-back");

    const currentClosed = await noticeFor(
      currentWorker("current-closed", {
        status: "running",
        ticketStatus: "closed",
      }),
    );
    expect(currentClosed).toContain("current-branch verification can run");
    expect(currentClosed).not.toContain("landing can be verified");

    const worktreeClosed = await noticeFor(
      worktreeWorker("worktree-closed", {
        status: "running",
        ticketStatus: "closed",
      }),
    );
    expect(worktreeClosed).toContain("landing can be verified");

    const currentExited = await noticeFor(
      currentWorker("current-exited", {
        status: "exited",
        ticketStatus: "closed",
      }),
    );
    expect(currentExited).toContain("current-branch verification still needs review");
    expect(currentExited).not.toContain("landing still needs review");

    const worktreeExited = await noticeFor(
      worktreeWorker("worktree-exited", {
        status: "exited",
        ticketStatus: "closed",
      }),
    );
    expect(worktreeExited).toContain("worktree landing still needs review");

    const currentRequest = await noticeFor(
      currentWorker("current-request", {
        status: "exited",
        ticketStatus: "open",
        landingRequestedAt: "2026-04-14T01:00:00.000Z",
      }),
    );
    expect(currentRequest).toContain("explicit current-branch verification request in flight");
    expect(currentRequest).not.toContain("landing request in flight");

    const worktreeRequest = await noticeFor(
      worktreeWorker("worktree-request", {
        status: "exited",
        ticketStatus: "open",
        landingRequestedAt: "2026-04-14T01:00:00.000Z",
      }),
    );
    expect(worktreeRequest).toContain("explicit landing request in flight");
  });

  it("shows explicit launch guidance after /bw delegate", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-delegate-guidance",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    launchTicketWorkerMock.mockResolvedValue({
      ...createWorkerRuntime(tempDir),
      status: "running",
      ticketStatus: "open",
      workerId: "bw-101-worker",
    });

    await harness.invokeCommand("bw", "delegate BW-101", ctx);

    const message = ui.notifications.at(-1)?.message ?? "";
    expect(message).toContain(
      "Launched worktree worker bw-101-worker for BW-101 in the background",
    );
    expect(message).toContain("[worktree]");
    expect(message).toContain("at worktreePath");
    expect(message).toContain("stay in the current pane");
    expect(message).toContain("background supervision keeps checking every 30s");
    expect(message).toContain("Follow streamed worker activity in");
    expect(message).toContain("when worktree landing is completed");
    expect(message).toContain(path.join(tempDir, ".pi", "beadwork", "workers", "runtime"));
  });

  it("shows current-branch launch guidance after /bw delegate", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-delegate-current-branch-guidance",
    });
    const {
      cleanupPolicy: _cleanupPolicy,
      worktreePath: _worktreePath,
      ...worker
    } = createWorkerRuntime(tempDir);

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    launchTicketWorkerMock.mockResolvedValue({
      ...worker,
      executionMode: "current-branch",
      checkoutPath: tempDir,
      branchName: "main",
      launchHead: "abc123",
      status: "running",
      ticketStatus: "open",
      workerId: "bw-101-worker",
    });

    await harness.invokeCommand("bw", "delegate BW-101", ctx);

    const message = ui.notifications.at(-1)?.message ?? "";
    expect(message).toContain(
      "Launched current-branch worker bw-101-worker for BW-101 in the background",
    );
    expect(message).toContain("[current-branch]");
    expect(message).toContain(`checkoutPath ${tempDir} (repo root)`);
    expect(message).toContain("when current-branch verification is completed");
    expect(message).not.toContain("landing is");
    expect(message).not.toContain("worktreePath");
  });

  it("passes one-off provider/model overrides through /bw delegate", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      sessionId: "session-delegate-model-override",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    launchTicketWorkerMock.mockResolvedValue({
      ...createWorkerRuntime(tempDir),
      status: "running",
      ticketStatus: "open",
      workerId: "bw-101-worker",
    });

    await harness.invokeCommand("bw", "delegate BW-101 --model cursor/composer-2", ctx);

    expect(launchTicketWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "BW-101",
        workerProviderOverride: "cursor",
        workerModelOverride: "composer-2",
      }),
    );
  });

  it("allows explicit landing requests for deferred workers", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-land-worker",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    await saveWorkerRegistry(
      resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json"),
      [
        {
          ...createWorkerRuntime(tempDir),
          status: "held" as const,
          ticketStatus: "closed",
          validationStatus: "passed" as const,
          landingAheadCount: 2,
          landingBehindCount: 0,
          landingVerification: "Validated and held. Ready to land.",
        },
      ],
    );
    requestWorkerLandingMock.mockResolvedValue({
      ...createWorkerRuntime(tempDir),
      status: "landed",
      ticketStatus: "closed",
      validationStatus: "passed",
      landingVerifiedAt: "2026-04-14T01:00:00.000Z",
      landingAheadCount: 0,
      landingBehindCount: 0,
      landingVerification: "Landing verified: worktree is clean and worker HEAD matches repo HEAD.",
    });

    await harness.invokeCommand("bw", "land BW-101", ctx);

    expect(requestWorkerLandingMock).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: "BW-101" }),
    );
    const message = ui.notifications.at(-1)?.message ?? "";
    expect(message).toContain("landed successfully");
    expect(message).toContain("BW-101 [worktree]");
  });

  it("rejects landing requests while the worker is still active", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-land-worker-active",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    const worker = {
      ...createWorkerRuntime(tempDir),
      status: "running" as const,
      ticketStatus: "open",
    };
    await saveWorkerRegistry(
      resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json"),
      [worker],
    );

    await harness.invokeCommand("bw", "land BW-101", ctx);

    expect(requestWorkerLandingMock).not.toHaveBeenCalled();
    expect(ui.notifications.at(-1)?.message).toContain(
      "Cannot land BW-101: worker is still active.",
    );
  });

  it("queues landing retries for background supervision instead of refreshing synchronously", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-land-worker-queued",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    await saveWorkerRegistry(
      resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json"),
      [
        {
          ...createWorkerRuntime(tempDir),
          status: "held" as const,
          ticketStatus: "closed",
          validationStatus: "passed" as const,
          landingAheadCount: 2,
          landingBehindCount: 1,
          landingVerification: "Validated and held. Landing needs refresh before merge-back.",
        },
      ],
    );
    requestWorkerLandingMock.mockResolvedValue({
      ...createWorkerRuntime(tempDir),
      status: "exited",
      ticketStatus: "closed",
      landingRequestedAt: "2026-04-16T16:00:00.000Z",
      validationStatus: "pending",
      validationSummary:
        "Explicit landing request queued. Background supervision will rerun validation and merge-back in the background.",
      landingVerification:
        "Explicit landing request queued. Background supervision will rerun validation and merge-back in the background.",
    });

    await harness.invokeCommand("bw", "land BW-101", ctx);

    const message = ui.notifications.at(-1)?.message ?? "";
    expect(message).toContain("Queued worktree landing retry for BW-101 [worktree]");
    expect(message).toContain("Background supervision will keep validating/reviewing/merging");

    const persisted = await loadSessionState(
      resolveSessionStateDir(tempDir, ".pi/beadwork/session-state"),
      "session-land-worker-queued",
    );
    expect(persisted.trackedWorkerIds).toContain("bw-101-worker");
    expect(ui.statuses.get("beadwork")).toContain("tracked 1");
  });

  it("uses current-branch verification wording for explicit verification requests", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-land-current-branch-worker",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    const {
      cleanupPolicy: _cleanupPolicy,
      worktreePath: _worktreePath,
      ...currentBase
    } = createWorkerRuntime(tempDir);
    const currentWorker = {
      ...currentBase,
      executionMode: "current-branch" as const,
      checkoutPath: tempDir,
      branchName: "main",
      launchHead: "abc123",
      status: "exited" as const,
      ticketStatus: "closed",
    } as WorkerRuntime;

    await saveWorkerRegistry(
      resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json"),
      [currentWorker],
    );
    requestWorkerLandingMock.mockResolvedValue({
      ...currentWorker,
      status: "verified",
      validationStatus: "passed",
      landingVerifiedAt: "2026-04-14T01:00:00.000Z",
      landingVerification: "Current-branch worker verified.",
    });

    await harness.invokeCommand("bw", "land BW-101", ctx);

    const message = ui.notifications.at(-1)?.message ?? "";
    expect(message).toContain("BW-101 [current-branch] verified successfully");
    expect(message).toContain("Current-branch worker verified successfully");
    expect(message).not.toContain("landed successfully");
    expect(message).not.toContain("merge-back");
    expect(message).not.toContain("worktree");
  });

  it("rejects cleanup when the worker is configured for automatic cleanup", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-cleanup-restricted",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    const worker = {
      ...createWorkerRuntime(tempDir),
      status: "landed" as const,
      ticketStatus: "closed",
      cleanupPolicy: "cleanup-after-landing" as const,
      landingVerifiedAt: "2026-04-14T01:00:00.000Z",
      landingVerification: "Landing verified.",
      landingBehindCount: 1,
    };
    await saveWorkerRegistry(
      resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json"),
      [worker],
    );

    await harness.invokeCommand("bw", "cleanup BW-101", ctx);

    expect(ui.notifications.at(-1)?.message).toContain(
      "Cannot cleanup BW-101: cleanup policy is cleanup-after-landing.",
    );
  });

  it("cleans runtime artifacts for verified current-branch workers", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-cleanup-current-branch",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    const registryPath = resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json");
    const worker = {
      ...createWorkerRuntime(tempDir),
      executionMode: "current-branch" as const,
      checkoutPath: tempDir,
      branchName: "feature/current-branch-worker",
      launchHead: "abc1234",
      worktreePath: undefined,
      status: "verified" as const,
      ticketStatus: "closed",
      cleanupPolicy: undefined,
      landingVerifiedAt: "2026-04-14T01:00:00.000Z",
      landingVerification: "Current-branch worker verified.",
    };
    await mkdir(worker.runtimeDir, { recursive: true });
    await writeFile(worker.logFile, "worker log");
    await saveWorkerRegistry(registryPath, [worker]);

    await harness.invokeCommand("bw", "cleanup BW-101", ctx);

    await expect(access(worker.runtimeDir)).rejects.toThrow();
    const [persisted] = await loadWorkerRegistry(registryPath);
    expect(persisted).toMatchObject({
      workerId: worker.workerId,
      status: "verified",
      cleanupStatus: "cleaned",
    });
    expect(ui.notifications.at(-1)?.message).toContain(
      "Cleanup completed for BW-101: current-branch runtime removed.",
    );
  });

  it("tracks delegated workers from a neutral session and notifies once when they land", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-worker-tracking",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    const worker = {
      ...createWorkerRuntime(tempDir),
      status: "landed" as const,
      ticketStatus: "closed",
      validationStatus: "passed" as const,
      validationSummary: "Validation passed: npm run lint, npm run test, npm run typecheck.",
      cleanupPolicy: "keep" as const,
      landingVerifiedAt: "2026-04-14T01:00:00.000Z",
      landingAheadCount: 0,
      landingBehindCount: 1,
      landingVerification:
        "Landing verified: worktree is clean and worker HEAD is fully contained in repo HEAD.",
    };
    await saveWorkerRegistry(
      resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json"),
      [worker],
    );

    const stateDir = resolveSessionStateDir(tempDir, ".pi/beadwork/session-state");
    await saveSessionState(stateDir, "session-worker-tracking", {
      mode: "neutral",
      scope: { kind: "none" },
      updatedAt: "2026-04-14T00:00:00.000Z",
      trackedWorkerIds: [worker.workerId],
    });

    await harness.dispatch("turn_end", { reason: "assistant" }, ctx);

    expect(ui.notifications.at(-1)?.message).toContain(
      "Delegated ticket BW-101 completed successfully",
    );
    expect(ui.notifications.at(-1)?.message).toContain("[worktree]");

    const persisted = await loadSessionState(stateDir, "session-worker-tracking");
    expect(persisted.trackedWorkerIds).toBeUndefined();
    expect(persisted.workerNotices?.[worker.workerId]).toContain("landed");

    const notificationCount = ui.notifications.length;
    await harness.dispatch("turn_end", { reason: "assistant" }, ctx);
    expect(ui.notifications).toHaveLength(notificationCount);
  });

  it("does not re-notify identical review-blocked workers when only landingRequestedAt changes", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-worker-attention-dedupe",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    const stateDir = resolveSessionStateDir(tempDir, ".pi/beadwork/session-state");
    const registryPath = resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json");
    const worker = {
      ...createWorkerRuntime(tempDir),
      status: "attention" as const,
      ticketStatus: "closed",
      validationStatus: "passed" as const,
      reviewStatus: "review-blocked" as const,
      reviewSummary: "Reviewer gate failed: output was malformed.",
      landingVerification: "Landing blocked: reviewer gate failed (output was malformed).",
      lastError: "Reviewer gate failed: output was malformed.",
      landingRequestedAt: "2026-04-16T17:40:00.000Z",
    };

    await saveWorkerRegistry(registryPath, [worker]);
    await saveSessionState(stateDir, "session-worker-attention-dedupe", {
      mode: "neutral",
      scope: { kind: "none" },
      updatedAt: "2026-04-16T17:40:00.000Z",
      trackedWorkerIds: [worker.workerId],
    });

    await harness.dispatch("turn_end", { reason: "assistant" }, ctx);
    const firstWarningCount = ui.notifications.length;
    expect(ui.notifications.at(-1)?.message).toContain("Delegated ticket BW-101");

    await saveWorkerRegistry(registryPath, [
      {
        ...worker,
        landingRequestedAt: "2026-04-16T17:41:00.000Z",
        updatedAt: "2026-04-16T17:41:00.000Z",
      },
    ]);

    await harness.dispatch("turn_end", { reason: "assistant" }, ctx);
    expect(ui.notifications).toHaveLength(firstWarningCount);
  });

  it("tracks delegated workers in the background without manual polling", async () => {
    vi.stubEnv("PI_BEADWORK_SUPERVISOR_POLL_INTERVAL_MS", "10");

    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-background-worker-tracking",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    const worker = {
      ...createWorkerRuntime(tempDir),
      status: "landed" as const,
      ticketStatus: "closed",
      validationStatus: "passed" as const,
      validationSummary: "Validation passed: npm run lint, npm run test, npm run typecheck.",
      cleanupPolicy: "keep" as const,
      landingVerifiedAt: "2026-04-14T01:00:00.000Z",
      landingAheadCount: 0,
      landingBehindCount: 1,
      landingVerification:
        "Landing verified: worktree is clean and worker HEAD is fully contained in repo HEAD.",
    };
    await saveWorkerRegistry(
      resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json"),
      [worker],
    );

    const stateDir = resolveSessionStateDir(tempDir, ".pi/beadwork/session-state");
    await saveSessionState(stateDir, "session-background-worker-tracking", {
      mode: "neutral",
      scope: { kind: "none" },
      updatedAt: "2026-04-14T00:00:00.000Z",
      trackedWorkerIds: [worker.workerId],
    });

    await harness.dispatch("session_start", { reason: "startup" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(
      ui.notifications.some((entry) =>
        entry.message.includes("Delegated ticket BW-101 completed successfully"),
      ),
    ).toBe(true);
    expect(ui.notifications.some((entry) => entry.message.includes("[worktree]"))).toBe(true);

    const persisted = await loadSessionState(stateDir, "session-background-worker-tracking");
    expect(persisted.trackedWorkerIds).toBeUndefined();

    await harness.dispatch("session_shutdown", { reason: "shutdown" }, ctx);
  });

  it("persists recent run state when /bw run pauses immediately", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ctx = createFakeExtensionContext({ cwd: tempDir, sessionId: "session-run-paused" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    adapterMock.show.mockResolvedValue({
      id: "BW-100",
      title: "Runnable epic",
      description: "description",
      status: "open",
      type: "epic",
      priority: 2,
      labels: [],
      blockedBy: [],
      blocks: [],
      assignee: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
      children: [],
    });
    runBoundedEpicLoopMock.mockResolvedValue({
      epicId: "BW-100",
      stopReason: "blocked",
      cycles: 2,
      launched: ["BW-101"],
      activeWorkerIds: [],
      workerSummary: {
        total: 0,
        active: 0,
        launching: 0,
        running: 0,
        exited: 0,
        held: 0,
        landed: 0,
        failed: 0,
        attention: 0,
        cleaned: 0,
      },
      notes: ["waiting for more ready work"],
      cycleSummaries: [
        {
          cycle: 1,
          ready: ["BW-101"],
          launched: ["BW-101"],
          running: [],
          held: [],
          landed: [],
          failed: [],
          attention: [],
          exited: [],
        },
      ],
    });

    await harness.invokeCommand("bw", "run BW-100 --workers 3 --max-cycles 4 --no-spawn", ctx);

    const persisted = await loadSessionState(
      resolveSessionStateDir(tempDir, ".pi/beadwork/session-state"),
      "session-run-paused",
    );
    expect(persisted.mode).toBe("interactive");
    expect(persisted.runOptions).toBeUndefined();
    expect(persisted.lastRunOptions).toEqual({
      workers: 3,
      until: "blocked",
      noSpawn: true,
      dryRun: false,
      maxCycles: 4,
    });
    expect(persisted.recentRunSummary?.stopReason).toBe("blocked");
    expect(persisted.recentRunSummary?.cycleSummaries).toHaveLength(1);
  });
  it("continues /bw run in the background while the session is idle", async () => {
    vi.stubEnv("PI_BEADWORK_SUPERVISOR_POLL_INTERVAL_MS", "10");

    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-run-bg" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    runBoundedEpicLoopMock
      .mockResolvedValueOnce(createRunSummary("max-cycles"))
      .mockResolvedValueOnce(createRunSummary("blocked"));

    await harness.invokeCommand("bw", "run BW-100 --max-cycles 1", ctx);
    expect(runBoundedEpicLoopMock).toHaveBeenCalledTimes(1);
    expect(
      ui.notifications.some((entry) =>
        entry.message.includes("Background supervision remains armed for BW-100"),
      ),
    ).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(runBoundedEpicLoopMock).toHaveBeenCalledTimes(2);
    expect(
      ui.notifications.some((entry) =>
        entry.message.includes("Background /bw run paused for BW-100"),
      ),
    ).toBe(true);

    const stateDir = resolveSessionStateDir(tempDir, ".pi/beadwork/session-state");
    const persisted = await loadSessionState(stateDir, "session-run-bg");
    expect(persisted.mode).toBe("interactive");
    expect(persisted.runOptions).toBeUndefined();

    await harness.dispatch("session_shutdown", { reason: "shutdown" }, ctx);
  });

  it("warns before /bw off when active workers are still running", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-off-warn" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    const worker = createWorkerRuntime(tempDir);
    await mkdir(worker.runtimeDir, { recursive: true });
    await writeFile(worker.stateFile, "running\n", "utf8");
    await saveWorkerRegistry(
      resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json"),
      [worker],
    );

    await harness.invokeCommand("bw", "engage BW-100", ctx);
    await harness.invokeCommand("bw", "off", ctx);

    const stateDir = resolveSessionStateDir(tempDir, ".pi/beadwork/session-state");
    const persisted = await loadSessionState(stateDir, "session-off-warn");
    expect(persisted.mode).toBe("interactive");
    expect(ui.notifications.at(-1)?.message).toContain("Active beadwork workers are still running");
  });

  it("can reset the session while leaving active workers running", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-off" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    const worker = createWorkerRuntime(tempDir);
    await mkdir(worker.runtimeDir, { recursive: true });
    await writeFile(worker.stateFile, "running\n", "utf8");
    await saveWorkerRegistry(
      resolveWorkerRegistryPath(tempDir, ".pi/beadwork/workers/registry.json"),
      [worker],
    );

    await harness.dispatch("session_start", { reason: "startup" }, ctx);
    await harness.invokeCommand("bw", "off --leave-workers", ctx);

    const stateDir = resolveSessionStateDir(tempDir, ".pi/beadwork/session-state");
    const persisted = await loadSessionState(stateDir, "session-off");
    expect(persisted.mode).toBe("neutral");
    expect(persisted.scope).toEqual({ kind: "none" });
    expect(ui.notifications.at(-2)?.message).toBe(
      "Beadwork session mode reset to neutral; active workers were left running.",
    );
    expect(ui.notifications.at(-1)?.message).toContain("Mode: neutral");
  });
});
