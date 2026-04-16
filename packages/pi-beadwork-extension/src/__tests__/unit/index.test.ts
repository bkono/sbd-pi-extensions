import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import beadworkExtension from "../../index.js";
import { resolveWorkerRegistryPath, saveWorkerRegistry } from "../../registry.js";
import { loadSessionState, resolveSessionStateDir, saveSessionState } from "../../session-state.js";
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
  });

  it("registers the /bw command", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    expect(harness.commands.has("bw")).toBe(true);
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
    expect(message).toContain("Launched worker bw-101-worker for BW-101 in the background");
    expect(message).toContain("stay in the current pane");
    expect(message).toContain("background supervision keeps checking every 30s");
    expect(message).toContain("Follow streamed worker activity in");
    expect(message).toContain(path.join(tempDir, ".pi", "beadwork", "workers", "runtime"));
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
    expect(message).toContain("Queued landing retry for BW-101");
    expect(message).toContain("Background supervision will keep validating/reviewing/merging");

    const persisted = await loadSessionState(
      resolveSessionStateDir(tempDir, ".pi/beadwork/session-state"),
      "session-land-worker-queued",
    );
    expect(persisted.trackedWorkerIds).toContain("bw-101-worker");
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

    const persisted = await loadSessionState(stateDir, "session-background-worker-tracking");
    expect(persisted.trackedWorkerIds).toBeUndefined();

    await harness.dispatch("session_shutdown", { reason: "shutdown" }, ctx);
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
