import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import beadworkExtension from "../../index.js";
import { loadSessionState, resolveSessionStateDir } from "../../session-state.js";
import {
  createExtensionTestHarness,
  createFakeExtensionContext,
  createFakeUi,
} from "../helpers/extension-harness.js";

const { detectActivationMock, adapterMock, createBeadworkAdapterMock } = vi.hoisted(() => ({
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
}));

vi.mock("@earendil-works/pi-ai", () => ({
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

function runnableEpic() {
  return {
    id: "BW-100",
    title: "Runnable epic",
    description: "description",
    status: "open",
    type: "epic",
    priority: 2,
    labels: [] as string[],
    blockedBy: [] as string[],
    blocks: [] as string[],
    assignee: "",
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    children: [
      {
        id: "BW-101",
        title: "Child task",
        description: "",
        status: "open",
        type: "task",
        priority: 2,
        labels: [] as string[],
        blockedBy: [] as string[],
        blocks: [] as string[],
        assignee: "",
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    ],
  };
}

describe("pi beadwork extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    createBeadworkAdapterMock.mockReturnValue(adapterMock);
    adapterMock.prime.mockResolvedValue("prime guidance");
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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
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
    expect(harness.commands.has("bw:run")).toBe(true);
    expect(harness.commands.has("bw:abandon")).toBe(true);
    expect(harness.commands.has("bw:off")).toBe(true);
    expect(harness.commands.has("bw:adopt")).toBe(true);
    expect(harness.commands.has("bw:workers")).toBe(false);
    expect(harness.commands.has("bw:delegate")).toBe(false);
    expect(harness.commands.has("bw:land")).toBe(false);
    expect(harness.commands.has("bw:cancel")).toBe(false);
    expect(harness.commands.has("bw:cleanup")).toBe(false);
  });

  it("registers inspection and mutation tools without deleted worker tools", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const names = [...harness.tools.keys()];
    console.log("registered beadwork tools:", names.join(", "));

    expect(names).not.toContain("beadwork_delegate");
    expect(names).not.toContain("beadwork_worker_done");
    expect(names).not.toContain("beadwork_land_worker");
    expect(names).not.toContain("beadwork_worker_check");
    expect(names).toContain("beadwork_sync");
    expect(names).toContain("beadwork_start_issue");
    expect(names).toContain("beadwork_close_issue");
    expect(names).toContain("beadwork_show");
    expect(names).toContain("beadwork_reopen_issue");
    expect(names).toContain("beadwork_create_issue");
    expect(names).toContain("beadwork_update_issue");
    expect(names).toContain("beadwork_comment_issue");
    expect(names).toContain("beadwork_label_issue");
    expect(names).toContain("beadwork_defer_issue");
    expect(names).toContain("beadwork_add_dependency");
    expect(names).toContain("beadwork_remove_dependency");
  });

  it("does not registerTool deleted worker tools in source", async () => {
    const source = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/registerTool\(\{[\s\S]*?name:\s*"beadwork_delegate"/);
    expect(source).not.toContain('name: "beadwork_delegate"');
    expect(source).not.toContain('name: "beadwork_worker_done"');
    expect(source).not.toContain('name: "beadwork_land_worker"');
    expect(source).not.toContain('name: "beadwork_worker_check"');
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

  it("starts goal mode from the issue explorer without a run-clarify modal", async () => {
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
      children: [
        {
          id: "BW-101",
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
        },
      ],
    });

    await harness.invokeCommand("bw", "", ctx);
    await Promise.resolve();
    await Promise.resolve();

    const dashboard = ui.customCalls[0]?.component as
      | { handleInput: (data: string) => void }
      | undefined;
    dashboard?.handleInput("r");
    await vi.waitFor(() => {
      expect(harness.sentMessages.length).toBe(1);
    });

    expect(ui.customCalls).toHaveLength(1);
    expect(
      ui.notifications.some((entry) => entry.message.includes("Goal mode started for BW-100")),
    ).toBe(true);
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
    expect(items.map((item) => item.value)).toEqual(expect.arrayContaining(["dep", "defer"]));
    expect(items.map((item) => item.value)).not.toContain("delegate");
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

  it("persists a V1 goal and injects a parent prompt on /bw run", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-run-goal",
    });

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
      children: [
        {
          id: "BW-101",
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
        },
      ],
    });

    await harness.invokeCommand("bw", "run BW-100", ctx);

    expect(harness.sentMessages).toHaveLength(1);
    const injected = harness.sentMessages[0];
    expect(injected?.options).toEqual({ triggerTurn: true });
    const injectedContent = String(
      (injected?.message as { content?: string } | undefined)?.content ?? "",
    );
    expect(injectedContent).toContain("BW-100");
    expect(injectedContent).not.toContain("BW-101");
    expect(
      ui.notifications.some((entry) => entry.message.includes("Goal mode started for BW-100")),
    ).toBe(true);

    const persisted = await loadSessionState(
      resolveSessionStateDir(tempDir, ".pi/beadwork/session-state"),
      "session-run-goal",
    );
    expect(persisted.mode).toBe("run");
    expect(persisted.goal?.scopeIds).toEqual(["BW-100"]);
    expect(persisted.goal?.reviewPolicy).toBe("ticket");
    expect(persisted.runOptions).toBeUndefined();
  });

  it("exits goal mode when beadwork_close_issue closes the scoped epic", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-close-epic",
      isIdle: () => false,
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    adapterMock.show.mockResolvedValue(runnableEpic());
    adapterMock.close.mockResolvedValue({ ...runnableEpic(), status: "closed", children: [] });

    await harness.invokeCommand("bw", "run BW-100", ctx);
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await harness.invokeTool("beadwork_close_issue", { id: "BW-100" }, ctx);

    const persisted = await loadSessionState(
      resolveSessionStateDir(tempDir, ".pi/beadwork/session-state"),
      "session-close-epic",
    );
    expect(persisted.mode).not.toBe("run");
    expect(persisted.goal).toBeUndefined();
    expect(harness.sentUserMessages).toHaveLength(1);
    expect(harness.sentUserMessages[0]?.options).toEqual({ deliverAs: "followUp" });
    expect(String(harness.sentUserMessages[0]?.content ?? "")).toContain("/halt group");
    expect(harness.sentMessages).toHaveLength(0);

    const appendix = await harness.dispatch<{ systemPrompt?: string }>(
      "before_agent_start",
      { systemPrompt: "Base prompt" },
      ctx,
    );
    expect(appendix?.systemPrompt).not.toContain("You are in beadwork run mode.");
  });

  it("keeps goal mode when a ticket is closed", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-close-ticket",
      isIdle: () => false,
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    adapterMock.show.mockResolvedValue(runnableEpic());
    adapterMock.close.mockResolvedValue({
      id: "BW-101",
      title: "Child task",
      description: "",
      status: "closed",
      type: "task",
      priority: 2,
      labels: [],
      blockedBy: [],
      blocks: [],
      assignee: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    });

    await harness.invokeCommand("bw", "run BW-100", ctx);
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await harness.invokeTool("beadwork_close_issue", { id: "BW-101" }, ctx);

    const persisted = await loadSessionState(
      resolveSessionStateDir(tempDir, ".pi/beadwork/session-state"),
      "session-close-ticket",
    );
    expect(persisted.mode).toBe("run");
    expect(persisted.goal?.scopeIds).toEqual(["BW-100"]);
    expect(harness.sentUserMessages).toHaveLength(0);
    expect(harness.sentMessages).toHaveLength(0);

    const appendix = await harness.dispatch<{ systemPrompt?: string }>(
      "before_agent_start",
      { systemPrompt: "Base prompt" },
      ctx,
    );
    expect(appendix?.systemPrompt).toContain("You are in beadwork run mode.");
  });

  it("exits goal mode on /bw abandon and queues a halt continuation", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-abandon",
      isIdle: () => true,
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    adapterMock.show.mockResolvedValue(runnableEpic());

    await harness.invokeCommand("bw", "run BW-100", ctx);
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await harness.invokeCommand("bw", "abandon", ctx);

    const persisted = await loadSessionState(
      resolveSessionStateDir(tempDir, ".pi/beadwork/session-state"),
      "session-abandon",
    );
    expect(persisted.mode).not.toBe("run");
    expect(persisted.goal).toBeUndefined();
    expect(adapterMock.close).not.toHaveBeenCalled();
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.options).toEqual({ triggerTurn: true });
    expect(
      String((harness.sentMessages[0]?.message as { content?: string } | undefined)?.content ?? ""),
    ).toContain("/halt group");
    expect(
      ui.notifications.some((entry) => entry.message.includes("Goal mode ended for BW-100")),
    ).toBe(true);

    const appendix = await harness.dispatch<{ systemPrompt?: string }>(
      "before_agent_start",
      { systemPrompt: "Base prompt" },
      ctx,
    );
    expect(appendix?.systemPrompt).not.toContain("You are in beadwork run mode.");
  });

  it("does not exit goal mode on halt-only", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-halt-only",
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    adapterMock.show.mockResolvedValue(runnableEpic());

    await harness.invokeCommand("bw", "run BW-100", ctx);
    expect(harness.commands.has("halt")).toBe(false);
    expect(harness.tools.has("halt")).toBe(false);

    const persisted = await loadSessionState(
      resolveSessionStateDir(tempDir, ".pi/beadwork/session-state"),
      "session-halt-only",
    );
    expect(persisted.mode).toBe("run");
    expect(persisted.goal?.scopeIds).toEqual(["BW-100"]);

    const appendix = await harness.dispatch<{ systemPrompt?: string }>(
      "before_agent_start",
      { systemPrompt: "Base prompt" },
      ctx,
    );
    expect(appendix?.systemPrompt).toContain("You are in beadwork run mode.");
  });

  it("does not arm tmux background supervision from /bw run", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-run-bg" });

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
      children: [
        {
          id: "BW-101",
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
        },
      ],
    });

    await harness.invokeCommand("bw", "run BW-100", ctx);
    expect(
      ui.notifications.some((entry) =>
        entry.message.includes("Background supervision remains armed"),
      ),
    ).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
  });

  it("resets the session with /bw off", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-off" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    await harness.dispatch("session_start", { reason: "startup" }, ctx);
    await harness.invokeCommand("bw", "engage BW-100", ctx);
    await harness.invokeCommand("bw", "off", ctx);

    const stateDir = resolveSessionStateDir(tempDir, ".pi/beadwork/session-state");
    const persisted = await loadSessionState(stateDir, "session-off");
    expect(persisted.mode).toBe("neutral");
    expect(persisted.scope).toEqual({ kind: "none" });
    expect(harness.sentMessages).toEqual([]);
    expect(harness.sentUserMessages).toEqual([]);
    expect(ui.notifications.some((entry) => entry.message.includes("reset to neutral"))).toBe(true);
  });

  it("queues a group halt when /bw off leaves run mode", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-off-run",
      isIdle: () => false,
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    adapterMock.show.mockResolvedValue(runnableEpic());

    await harness.invokeCommand("bw", "run BW-100", ctx);
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await harness.invokeCommand("bw", "off", ctx);

    const persisted = await loadSessionState(
      resolveSessionStateDir(tempDir, ".pi/beadwork/session-state"),
      "session-off-run",
    );
    expect(persisted.mode).toBe("neutral");
    expect(persisted.goal).toBeUndefined();
    expect(harness.sentUserMessages).toHaveLength(1);
    expect(harness.sentUserMessages[0]?.options).toEqual({ deliverAs: "followUp" });
    expect(String(harness.sentUserMessages[0]?.content ?? "")).toContain("/halt group");
    expect(ui.notifications.some((entry) => entry.message.includes("reset to neutral"))).toBe(true);
  });

  it("exits goal mode on status refresh when the scoped epic is already closed", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({
      cwd: tempDir,
      ui,
      sessionId: "session-refresh-closed",
      isIdle: () => false,
    });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });
    adapterMock.show.mockResolvedValue(runnableEpic());

    await harness.invokeCommand("bw", "run BW-100", ctx);
    adapterMock.show.mockResolvedValue({ ...runnableEpic(), status: "closed", children: [] });
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await harness.invokeTool("beadwork_status", {}, ctx);

    const persisted = await loadSessionState(
      resolveSessionStateDir(tempDir, ".pi/beadwork/session-state"),
      "session-refresh-closed",
    );
    expect(persisted.mode).not.toBe("run");
    expect(persisted.goal).toBeUndefined();
    expect(harness.sentUserMessages).toHaveLength(1);
    expect(String(harness.sentUserMessages[0]?.content ?? "")).toContain("/halt group");
  });

  it("does not import the deleted tmux orchestrator", async () => {
    const source = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    expect(source).not.toContain("runBoundedEpicLoop");
    expect(source).not.toContain('from "./orchestrator.js"');
    expect(source).not.toContain('from "./tmux.js"');
    expect(source).not.toContain('from "./registry.js"');
  });
});
