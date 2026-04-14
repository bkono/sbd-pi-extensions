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

const { detectActivationMock } = vi.hoisted(() => ({
  detectActivationMock: vi.fn(),
}));

vi.mock("../../activation.js", () => ({
  detectActivation: detectActivationMock,
}));

describe("pi beadwork extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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

  it("shows activation and mode info via /bw status", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-ext-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "session-status" });

    detectActivationMock.mockResolvedValue({ kind: "active", repoRoot: tempDir });

    await harness.invokeCommand("bw", "status", ctx);

    expect(ui.notifications).toHaveLength(1);
    expect(ui.notifications[0].message).toContain("Activation: active");
    expect(ui.notifications[0].message).toContain("Mode: neutral");
    expect(ui.statuses.get("beadwork")).toContain("bw neutral");
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
