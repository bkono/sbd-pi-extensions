import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dropGoalMode,
  isInterruptedRun,
  loadSessionState,
  resetSessionState,
  resolveSessionStateDir,
  resolveSessionStatePath,
  saveSessionState,
} from "../../session-state.js";
import type { Goal, SessionState } from "../../types.js";

const goal: Goal = {
  goalId: "goal-BW-100",
  scopeIds: ["BW-100"],
  reviewPolicy: "ticket",
  startedAt: "2026-08-28T00:00:00.000Z",
};

const liveState: SessionState = {
  mode: "run",
  scope: { kind: "epic", id: "BW-100", title: "Epic title" },
  updatedAt: "2026-08-28T00:00:00.000Z",
  engagedAt: "2026-08-28T00:00:00.000Z",
  prime: {
    content: "prime guidance",
    loadedAt: "2026-08-28T00:01:00.000Z",
    repoRoot: "/repo",
  },
  goal,
};

const deletedPersistedFields = {
  trackedWorkerIds: ["bw-101-worker"],
  workerNotices: { "bw-101-worker": "waiting" },
  runOptions: { workers: 3, until: "blocked", noSpawn: false, dryRun: false, maxCycles: 5 },
  lastRunOptions: { workers: 2, until: "empty", noSpawn: true, dryRun: true },
  recentRunSummary: { epicId: "BW-100", stopReason: "max-cycles", cycles: 5 },
  lastCycleSummary: { cycle: 5, running: ["bw-101-worker"] },
};

function statePath(baseDir: string, sessionId: string): string {
  return resolveSessionStatePath(baseDir, sessionId);
}

describe("session state persistence", () => {
  it("loads a default neutral state when no file exists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));
    const state = await loadSessionState(tempDir, "session-1");

    expect(state.mode).toBe("neutral");
    expect(state.scope).toEqual({ kind: "none" });
    expect(typeof state.updatedAt).toBe("string");
  });

  it("round-trips only current goal-mode state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));
    const saved = await saveSessionState(tempDir, "session-goal", liveState);

    expect(saved).toEqual(liveState);
    expect(isInterruptedRun(saved)).toBe(false);

    const raw = await readFile(statePath(tempDir, "session-goal"), "utf8");
    expect(JSON.parse(raw)).toEqual(liveState);

    const loaded = await loadSessionState(tempDir, "session-goal");
    expect(loaded).toEqual({ ...liveState, runInterrupted: true });
    expect(isInterruptedRun(loaded)).toBe(true);
  });

  it("ignores deleted supervisor fields on read and never reserializes them", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));
    const filePath = statePath(tempDir, "session-legacy");
    await writeFile(
      filePath,
      `${JSON.stringify({ ...liveState, ...deletedPersistedFields })}\n`,
      "utf8",
    );

    const loaded = await loadSessionState(tempDir, "session-legacy");
    expect(loaded).toEqual({ ...liveState, runInterrupted: true });
    for (const field of Object.keys(deletedPersistedFields)) {
      expect(loaded).not.toHaveProperty(field);
    }

    await saveSessionState(tempDir, "session-legacy", loaded);
    const raw = await readFile(filePath, "utf8");
    for (const field of Object.keys(deletedPersistedFields)) {
      expect(raw).not.toContain(field);
    }
    expect(raw).not.toContain("bw-101-worker");
  });

  it("drops deleted fields supplied by an untyped in-memory caller", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));
    const legacy = { ...liveState, ...deletedPersistedFields } as unknown as SessionState;
    const saved = await saveSessionState(tempDir, "session-memory", legacy);

    expect(saved).toEqual(liveState);
    const raw = await readFile(statePath(tempDir, "session-memory"), "utf8");
    for (const field of Object.keys(deletedPersistedFields)) {
      expect(raw).not.toContain(field);
    }
  });

  it("keeps an interrupted goal interrupted across in-memory saves", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));
    await writeFile(statePath(tempDir, "session-interrupted"), JSON.stringify(liveState), "utf8");

    const loaded = await loadSessionState(tempDir, "session-interrupted");
    const saved = await saveSessionState(tempDir, "session-interrupted", {
      ...loaded,
      updatedAt: "2026-08-28T00:02:00.000Z",
    });

    expect(isInterruptedRun(saved)).toBe(true);
    expect(JSON.parse(await readFile(statePath(tempDir, "session-interrupted"), "utf8"))).toEqual(
      saved,
    );
  });

  it("rejects goal records without exactly one epic id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));
    for (const scopeIds of [[], ["BW-100", "BW-200"]]) {
      const sessionId = `invalid-${scopeIds.length}`;
      await writeFile(
        statePath(tempDir, sessionId),
        JSON.stringify({ ...liveState, goal: { ...goal, scopeIds } }),
        "utf8",
      );
      expect((await loadSessionState(tempDir, sessionId)).goal).toBeUndefined();
    }
  });

  it("drops goal mode without resetting scope or prime", () => {
    const dropped = dropGoalMode({ ...liveState, runInterrupted: true });

    expect(dropped).toEqual({
      ...liveState,
      mode: "interactive",
      updatedAt: expect.any(String),
      goal: undefined,
      runInterrupted: undefined,
    });
  });

  it("resets state and resolves relative state directories", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));
    await saveSessionState(tempDir, "session-reset", liveState);
    const reset = await resetSessionState(tempDir, "session-reset");

    expect(reset.mode).toBe("neutral");
    expect(reset.scope).toEqual({ kind: "none" });
    expect(reset.prime).toBeUndefined();
    expect(resolveSessionStateDir("/repo", ".pi/beadwork/session-state")).toBe(
      path.resolve("/repo", ".pi/beadwork/session-state"),
    );
  });
});
