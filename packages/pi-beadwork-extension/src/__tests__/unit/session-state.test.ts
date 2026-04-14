import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSessionState,
  resetSessionState,
  resolveSessionStateDir,
  resolveSessionStatePath,
  saveSessionState,
} from "../../session-state.js";

describe("session state persistence", () => {
  it("loads a default neutral state when no file exists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));

    const state = await loadSessionState(tempDir, "session-1");

    expect(state.mode).toBe("neutral");
    expect(state.scope).toEqual({ kind: "none" });
    expect(typeof state.updatedAt).toBe("string");
  });

  it("saves and reloads session state including prime cache", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));

    await saveSessionState(tempDir, "session-1", {
      mode: "interactive",
      scope: { kind: "epic", id: "BW-100", title: "Epic title" },
      updatedAt: "2026-04-13T00:00:00.000Z",
      engagedAt: "2026-04-13T00:00:00.000Z",
      prime: {
        content: "prime guidance",
        loadedAt: "2026-04-13T00:01:00.000Z",
        repoRoot: "/repo",
      },
    });

    const state = await loadSessionState(tempDir, "session-1");
    expect(state).toEqual({
      mode: "interactive",
      scope: { kind: "epic", id: "BW-100", title: "Epic title" },
      updatedAt: "2026-04-13T00:00:00.000Z",
      engagedAt: "2026-04-13T00:00:00.000Z",
      prime: {
        content: "prime guidance",
        loadedAt: "2026-04-13T00:01:00.000Z",
        repoRoot: "/repo",
      },
    });

    const raw = await readFile(resolveSessionStatePath(tempDir, "session-1"), "utf8");
    expect(raw).toContain("BW-100");
    expect(raw).toContain("prime guidance");
  });

  it("resets a session back to neutral mode", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));

    await saveSessionState(tempDir, "session-1", {
      mode: "run",
      scope: { kind: "ticket", id: "BW-101" },
      updatedAt: "2026-04-13T00:00:00.000Z",
      engagedAt: "2026-04-13T00:00:00.000Z",
      prime: {
        content: "prime guidance",
        loadedAt: "2026-04-13T00:01:00.000Z",
      },
    });

    const reset = await resetSessionState(tempDir, "session-1");
    expect(reset.mode).toBe("neutral");
    expect(reset.scope).toEqual({ kind: "none" });
    expect(reset.prime).toBeUndefined();
  });

  it("resolves relative state directories under the provided root", () => {
    const resolved = resolveSessionStateDir("/repo", ".pi/beadwork/session-state");
    expect(resolved).toBe(path.resolve("/repo", ".pi/beadwork/session-state"));
  });
});
