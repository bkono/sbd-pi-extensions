import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkerRegistry, normalizeWorkerRecord, saveWorkerRegistry } from "../../registry.js";
import type { WorkerRuntime } from "../../types.js";

function worktreeWorker(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  return {
    workerId: "bw-101-worker",
    ticketId: "BW-101",
    epicId: "BW-100",
    ticketTitle: "Task",
    ticketStatus: "open",
    executionMode: "worktree",
    checkoutPath: "/tmp/worktree",
    branchName: "BW-101/task",
    worktreePath: "/tmp/worktree",
    backend: "tmux",
    tmuxSession: "pi-bw",
    tmuxWindow: "bw-101",
    tmuxPane: "%42",
    runtimeDir: "/tmp/runtime",
    promptFile: "/tmp/runtime/handoff.txt",
    scriptFile: "/tmp/runtime/launch.sh",
    logFile: "/tmp/runtime/worker.log",
    stateFile: "/tmp/runtime/state.txt",
    exitCodeFile: "/tmp/runtime/exit-code.txt",
    finishedAtFile: "/tmp/runtime/finished-at.txt",
    launchCommand: "bash /tmp/runtime/launch.sh",
    workerCommand: "pi",
    cleanupPolicy: "keep",
    landingPolicy: "deferred",
    validationStatus: "passed",
    reviewFeedback: ["nit"],
    commitShas: ["abc123"],
    touchedPaths: ["src/registry.ts"],
    status: "held",
    startedAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:01.000Z",
    ...overrides,
  };
}

function currentBranchWorker(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  const { cleanupPolicy: _cleanupPolicy, worktreePath: _worktreePath, ...base } = worktreeWorker();
  return {
    ...base,
    workerId: "bw-102-worker",
    ticketId: "BW-102",
    executionMode: "current-branch",
    checkoutPath: "/repo",
    branchName: "main",
    launchHead: "abc123",
    ...overrides,
  };
}

function legacyWorkerRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const {
    executionMode: _executionMode,
    checkoutPath: _checkoutPath,
    ...legacy
  } = worktreeWorker();
  return {
    ...legacy,
    ...overrides,
  };
}

describe("worker registry normalization", () => {
  it("normalizes legacy records without executionMode to worktree workers", () => {
    const legacy = legacyWorkerRecord({ worktreePath: "/repo-root-even-if-weird" });

    const normalized = normalizeWorkerRecord(legacy);

    expect(normalized.executionMode).toBe("worktree");
    expect(normalized.checkoutPath).toBe("/repo-root-even-if-weird");
    expect(normalized.worktreePath).toBe("/repo-root-even-if-weird");
  });

  it("preserves all legacy fields while adding normalized checkout fields", () => {
    const legacy = legacyWorkerRecord({
      checkoutPath: "/stale-value",
      extraLegacyField: { keep: true },
      remediationAttempts: 2,
    });

    const normalized = normalizeWorkerRecord(legacy) as WorkerRuntime & {
      extraLegacyField: { keep: boolean };
    };

    expect(normalized).toMatchObject({
      ...legacy,
      executionMode: "worktree",
      checkoutPath: legacy.worktreePath,
    });
    expect(normalized.extraLegacyField).toEqual({ keep: true });
    expect(normalized.remediationAttempts).toBe(2);
  });

  it("passes new current-branch records through without worktreePath", () => {
    const worker = currentBranchWorker();

    const normalized = normalizeWorkerRecord(worker);

    expect(normalized).toEqual(worker);
    expect("worktreePath" in normalized).toBe(false);
  });

  it("passes new worktree records through unchanged", () => {
    const worker = worktreeWorker();

    expect(normalizeWorkerRecord(worker)).toEqual(worker);
  });

  it("preserves normalized legacy records across load/save round trips", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-registry-"));
    const registryPath = path.join(tempDir, "registry.json");
    const legacy = legacyWorkerRecord({ worktreePath: path.join(tempDir, "worker") });

    await writeFile(registryPath, JSON.stringify({ workers: [legacy] }, null, 2), "utf8");

    const loaded = await loadWorkerRegistry(registryPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      executionMode: "worktree",
      checkoutPath: path.join(tempDir, "worker"),
      worktreePath: path.join(tempDir, "worker"),
    });

    await saveWorkerRegistry(registryPath, loaded);
    const saved = JSON.parse(await readFile(registryPath, "utf8")) as { workers: WorkerRuntime[] };

    expect(saved.workers).toEqual(loaded);
    expect(saved.workers[0]?.executionMode).toBe("worktree");
    expect(saved.workers[0]?.checkoutPath).toBe(path.join(tempDir, "worker"));
  });

  it("throws clear errors for malformed records", async () => {
    const { workerId: _workerId, ...missingWorkerId } = legacyWorkerRecord();
    expect(() => normalizeWorkerRecord(missingWorkerId)).toThrow(/workerId/);

    expect(() => normalizeWorkerRecord({ ...legacyWorkerRecord(), status: "surprised" })).toThrow(
      /status/,
    );

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-registry-"));
    const registryPath = path.join(tempDir, "registry.json");
    const { ticketId: _ticketId, ...missingTicketId } = legacyWorkerRecord();
    await writeFile(registryPath, JSON.stringify({ workers: [missingTicketId] }), "utf8");

    await expect(loadWorkerRegistry(registryPath)).rejects.toThrow(/index 0.*ticketId/);
  });
});
