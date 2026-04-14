import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    createIssue: vi.fn(),
    addDependency: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    sync: vi.fn(),
    getCounts: vi.fn(),
  },
  createBeadworkAdapterMock: vi.fn(),
}));

vi.mock("../../activation.js", () => ({
  detectActivation: detectActivationMock,
}));

vi.mock("../../bw.js", () => ({
  createBeadworkAdapter: createBeadworkAdapterMock,
}));

describe("pi beadwork extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
    adapterMock.getCounts.mockResolvedValue({
      ready: 2,
      blocked: 1,
      inProgress: 1,
      scopedReady: 1,
    });
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

  it("resets the stored session mode with /bw off", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-off" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    await harness.dispatch("session_start", { reason: "startup" }, ctx);
    await harness.invokeCommand("bw", "off", ctx);

    const stateDir = resolveSessionStateDir(tempDir, ".pi/beadwork/session-state");
    const persisted = await loadSessionState(stateDir, "session-off");
    expect(persisted.mode).toBe("neutral");
    expect(persisted.scope).toEqual({ kind: "none" });
    expect(ui.notifications.at(-2)?.message).toBe("Beadwork session mode reset to neutral.");
    expect(ui.notifications.at(-1)?.message).toContain("Mode: neutral");
  });
});
