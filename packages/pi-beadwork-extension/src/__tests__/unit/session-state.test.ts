import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isInterruptedRun,
  loadSessionState,
  resetSessionState,
  resolveSessionStateDir,
  resolveSessionStatePath,
  saveSessionState,
} from "../../session-state.js";
import type { Goal, SessionState } from "../../types.js";

describe("session state persistence", () => {
  it("loads a default neutral state when no file exists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));

    const state = await loadSessionState(tempDir, "session-1");

    expect(state.mode).toBe("neutral");
    expect(state.scope).toEqual({ kind: "none" });
    expect(typeof state.updatedAt).toBe("string");
  });

  it("saves and reloads session state including prime cache and run options", async () => {
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
      trackedWorkerIds: ["bw-101-worker"],
      workerNotices: {
        "bw-101-worker": "landed|closed|passed|verified|pending",
      },
      runOptions: {
        workers: 3,
        until: "blocked",
        noSpawn: true,
        dryRun: false,
        maxCycles: 5,
      },
      lastRunOptions: {
        workers: 2,
        until: "empty",
        noSpawn: false,
        dryRun: true,
        maxCycles: 1,
      },
      recentRunSummary: {
        epicId: "BW-100",
        stopReason: "blocked",
        cycles: 2,
        launched: ["BW-101"],
        activeWorkerIds: ["bw-101-worker"],
        workerSummary: {
          total: 1,
          active: 1,
          launching: 0,
          running: 1,
          exited: 0,
          held: 0,
          landed: 0,
          verified: 0,
          successfulTerminal: 0,
          failed: 0,
          attention: 0,
          cleaned: 0,
        },
        notes: ["waiting for blockers"],
        cycleSummaries: [
          {
            cycle: 1,
            ready: ["BW-101"],
            launched: ["BW-101"],
            running: ["bw-101-worker"],
            held: [],
            landed: [],
            verified: [],
            failed: [],
            attention: [],
            exited: [],
          },
        ],
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
      trackedWorkerIds: ["bw-101-worker"],
      workerNotices: {
        "bw-101-worker": "landed|closed|passed|verified|pending",
      },
      runOptions: {
        workers: 3,
        until: "blocked",
        noSpawn: true,
        dryRun: false,
        maxCycles: 5,
      },
      lastRunOptions: {
        workers: 2,
        until: "empty",
        noSpawn: false,
        dryRun: true,
        maxCycles: 1,
      },
      recentRunSummary: {
        epicId: "BW-100",
        stopReason: "blocked",
        cycles: 2,
        launched: ["BW-101"],
        activeWorkerIds: ["bw-101-worker"],
        workerSummary: {
          total: 1,
          active: 1,
          launching: 0,
          running: 1,
          exited: 0,
          held: 0,
          landed: 0,
          verified: 0,
          successfulTerminal: 0,
          failed: 0,
          attention: 0,
          cleaned: 0,
        },
        notes: ["waiting for blockers"],
        cycleSummaries: [
          {
            cycle: 1,
            ready: ["BW-101"],
            launched: ["BW-101"],
            running: ["bw-101-worker"],
            held: [],
            landed: [],
            verified: [],
            failed: [],
            attention: [],
            exited: [],
          },
        ],
      },
    });

    const raw = await readFile(resolveSessionStatePath(tempDir, "session-1"), "utf8");
    expect(raw).toContain("BW-100");
    expect(raw).toContain("prime guidance");
    expect(raw).toContain("bw-101-worker");
    expect(raw).toContain('"runOptions"');
    expect(raw).toContain('"lastRunOptions"');
    expect(raw).toContain('"recentRunSummary"');
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

  it("round-trips a V1 goal record", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));
    const goal: Goal = {
      goalId: "goal-BW-100",
      scopeIds: ["BW-100"],
      reviewPolicy: "ticket",
      startedAt: "2026-08-28T00:00:00.000Z",
    };

    const saved = await saveSessionState(tempDir, "session-goal", {
      mode: "run",
      scope: { kind: "epic", id: "BW-100", title: "Epic title" },
      updatedAt: "2026-08-28T00:00:00.000Z",
      engagedAt: "2026-08-28T00:00:00.000Z",
      goal,
    });

    expect(saved.goal).toEqual(goal);
    expect(saved.runInterrupted).toBeUndefined();

    const loaded = await loadSessionState(tempDir, "session-goal");
    expect(loaded.goal).toEqual(goal);
    expect(loaded.mode).toBe("run");
    expect(loaded.runInterrupted).toBe(true);
    expect(isInterruptedRun(loaded)).toBe(true);
  });

  it("rejects V1 goals that do not have exactly one epic id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));

    await saveSessionState(tempDir, "session-empty-scope", {
      mode: "run",
      scope: { kind: "epic", id: "BW-100" },
      updatedAt: "2026-08-28T00:00:00.000Z",
      goal: {
        goalId: "goal-empty",
        scopeIds: [],
        reviewPolicy: "ticket",
        startedAt: "2026-08-28T00:00:00.000Z",
      },
    });
    expect((await loadSessionState(tempDir, "session-empty-scope")).goal).toBeUndefined();

    await saveSessionState(tempDir, "session-multi-scope", {
      mode: "run",
      scope: { kind: "epic", id: "BW-100" },
      updatedAt: "2026-08-28T00:00:00.000Z",
      goal: {
        goalId: "goal-multi",
        scopeIds: ["BW-100", "BW-200"],
        reviewPolicy: "scope",
        startedAt: "2026-08-28T00:00:00.000Z",
      },
    });
    expect((await loadSessionState(tempDir, "session-multi-scope")).goal).toBeUndefined();
  });

  it("treats persisted run mode as interrupted and does not restore live workers", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));
    const live: SessionState = {
      mode: "run",
      scope: { kind: "epic", id: "BW-100" },
      updatedAt: "2026-08-28T00:00:00.000Z",
      goal: {
        goalId: "goal-BW-100",
        scopeIds: ["BW-100"],
        reviewPolicy: "none",
        startedAt: "2026-08-28T00:00:00.000Z",
      },
      trackedWorkerIds: ["bw-101-worker"],
      runOptions: {
        workers: 3,
        until: "blocked",
        noSpawn: false,
        dryRun: false,
        maxCycles: 5,
      },
    };

    const saved = await saveSessionState(tempDir, "session-run", live);
    expect(saved.trackedWorkerIds).toEqual(["bw-101-worker"]);
    expect(saved.runOptions).toEqual(live.runOptions);
    expect(isInterruptedRun(saved)).toBe(false);

    const raw = await readFile(resolveSessionStatePath(tempDir, "session-run"), "utf8");
    expect(raw).not.toContain("trackedWorkerIds");
    expect(raw).not.toContain("runOptions");
    expect(raw).toContain("goal-BW-100");

    const loaded = await loadSessionState(tempDir, "session-run");
    expect(loaded.mode).toBe("run");
    expect(loaded.runInterrupted).toBe(true);
    expect(isInterruptedRun(loaded)).toBe(true);
    expect(loaded.trackedWorkerIds).toBeUndefined();
    expect(loaded.runOptions).toBeUndefined();
    expect(loaded.goal).toEqual(live.goal);
  });

  it("marks leftover run JSON as interrupted even if supervisor fields are still on disk", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-state-"));
    await writeFile(
      resolveSessionStatePath(tempDir, "session-legacy-run"),
      `${JSON.stringify({
        mode: "run",
        scope: { kind: "epic", id: "BW-100" },
        updatedAt: "2026-08-28T00:00:00.000Z",
        trackedWorkerIds: ["bw-101-worker"],
        runOptions: {
          workers: 2,
          until: "empty",
          noSpawn: false,
          dryRun: false,
        },
      })}\n`,
      "utf8",
    );

    const loaded = await loadSessionState(tempDir, "session-legacy-run");
    expect(loaded.runInterrupted).toBe(true);
    expect(loaded.trackedWorkerIds).toBeUndefined();
    expect(loaded.runOptions).toBeUndefined();
    expect(isInterruptedRun(loaded)).toBe(true);
  });
});
