import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkerRegistry, saveWorkerRegistry } from "../../registry.js";
import { isCurrentBranchWorker, isWorktreeWorker, type WorkerRuntime } from "../../types.js";

function baseWorker(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  return {
    executionMode: "worktree",
    checkoutPath: "/tmp/worktree",
    branchName: "BW-101/task",
    worktreePath: "/tmp/worktree",
    workerId: "bw-101-worker",
    ticketId: "BW-101",
    ticketTitle: "Task",
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
    status: "running",
    startedAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    ...overrides,
  };
}

function currentBranchWorker(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  const { cleanupPolicy: _cleanupPolicy, worktreePath: _worktreePath, ...base } = baseWorker();
  return {
    ...base,
    executionMode: "current-branch",
    checkoutPath: "/repo",
    branchName: "main",
    launchHead: "abc123",
    ...overrides,
  };
}

describe("worker runtime checkout types", () => {
  it("narrows worktree workers with checkoutPath and worktreePath", () => {
    const worker = baseWorker();

    expect(isWorktreeWorker(worker)).toBe(true);
    expect(isCurrentBranchWorker(worker)).toBe(false);

    if (isWorktreeWorker(worker)) {
      expect(worker.checkoutPath).toBe(worker.worktreePath);
    }
  });

  it("narrows current-branch workers without faking worktreePath", () => {
    const worker = currentBranchWorker();

    expect(isCurrentBranchWorker(worker)).toBe(true);
    expect(isWorktreeWorker(worker)).toBe(false);
    expect(worker.checkoutPath).toBe("/repo");
    expect("worktreePath" in worker).toBe(false);

    if (isCurrentBranchWorker(worker)) {
      expect(worker.launchHead).toBe("abc123");
    }
  });

  it("rejects worktreePath access after current-branch narrowing", () => {
    const worker = currentBranchWorker();

    if (isCurrentBranchWorker(worker)) {
      // @ts-expect-error current-branch workers must not expose worktreePath
      expect(worker.worktreePath).toBeUndefined();
    }
  });

  it("round-trips both checkout shapes and optional verification fields", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-types-"));
    const registryPath = path.join(tempDir, "registry.json");
    const currentWorker = currentBranchWorker({
      workerId: "bw-102-worker",
      ticketId: "BW-102",
      commitShas: ["abc123"],
      touchedPaths: ["src/types.ts"],
    });
    const worktreeWorker = baseWorker({
      commitShas: ["def456"],
      touchedPaths: ["src/worktree.ts"],
    });

    await saveWorkerRegistry(registryPath, [currentWorker, worktreeWorker]);
    const loaded = await loadWorkerRegistry(registryPath);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.checkoutPath).toBe("/repo");
    expect(loaded[0]?.commitShas).toEqual(["abc123"]);
    expect(loaded[0]?.touchedPaths).toEqual(["src/types.ts"]);
    expect("worktreePath" in (loaded[0] ?? {})).toBe(false);
    expect(loaded[1]?.checkoutPath).toBe("/tmp/worktree");
    expect(loaded[1]?.commitShas).toEqual(["def456"]);
    expect(loaded[1]?.touchedPaths).toEqual(["src/worktree.ts"]);
  });
});
