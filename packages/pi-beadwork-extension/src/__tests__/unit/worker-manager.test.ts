import { describe, expect, it } from "vitest";
import {
  buildWorkerManagerPanelLines,
  getWorkerActionAvailability,
  groupWorkersForManager,
} from "../../tui/worker-manager.js";
import type { SessionState, WorkerRuntime } from "../../types.js";

function createWorker(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
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
    status: "running",
    startedAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:01.000Z",
    ...overrides,
  };
}

const neutralState: SessionState = {
  mode: "neutral",
  scope: { kind: "none" },
  updatedAt: "2026-04-14T00:00:00.000Z",
};

describe("worker manager", () => {
  it("groups tracked background workers separately from epic groups", () => {
    const backgroundTracked = createWorker({
      workerId: "bw-101-worker",
      ticketId: "BW-101",
      epicId: "BW-100",
      status: "held",
      ticketStatus: "closed",
      validationStatus: "passed",
      landingAheadCount: 1,
      landingBehindCount: 0,
      landingVerification: "Validated and held. Ready to land.",
    });
    const epicWorker = createWorker({
      workerId: "bw-102-worker",
      ticketId: "BW-102",
      epicId: "BW-100",
      status: "running",
      startedAt: "2026-04-14T00:05:00.000Z",
      updatedAt: "2026-04-14T00:05:01.000Z",
    });
    const otherEpicWorker = createWorker({
      workerId: "bw-201-worker",
      ticketId: "BW-201",
      epicId: "BW-200",
      status: "attention",
      ticketStatus: "closed",
      validationStatus: "failed",
      validationSummary: "npm run test failed",
      lastError: "npm run test failed",
      startedAt: "2026-04-14T00:10:00.000Z",
      updatedAt: "2026-04-14T00:10:01.000Z",
    });

    const groups = groupWorkersForManager({
      workers: [epicWorker, otherEpicWorker, backgroundTracked],
      state: {
        ...neutralState,
        trackedWorkerIds: [backgroundTracked.workerId],
      },
    });

    expect(groups.map((group) => group.label)).toEqual([
      "Manual / background",
      "Epic BW-200",
      "Epic BW-100",
    ]);
    expect(groups[0]?.workers.map((entry) => entry.worker.ticketId)).toEqual(["BW-101"]);
    expect(groups[1]?.attention).toBe(1);
  });

  it("computes explicit land/cancel/cleanup action guards", () => {
    const heldWorker = createWorker({
      status: "held",
      ticketStatus: "closed",
      validationStatus: "passed",
      landingAheadCount: 2,
      landingBehindCount: 0,
      landingVerification: "Validated and held. Ready to land.",
    });
    const runningWorker = createWorker({
      status: "running",
      ticketStatus: "open",
    });
    const manualCleanupWorker = createWorker({
      status: "landed",
      ticketStatus: "closed",
      cleanupPolicy: "keep",
      landingVerifiedAt: "2026-04-14T01:00:00.000Z",
      landingVerification: "Landing verified.",
      landingBehindCount: 1,
    });
    const autoCleanupWorker = createWorker({
      status: "landed",
      ticketStatus: "closed",
      cleanupPolicy: "cleanup-after-landing",
      landingVerifiedAt: "2026-04-14T01:00:00.000Z",
      landingVerification: "Landing verified.",
      landingBehindCount: 1,
    });
    const verifiedWorker = {
      ...createWorker({
        status: "verified",
        ticketStatus: "closed",
        validationStatus: "passed",
        landingVerifiedAt: "2026-04-14T01:00:00.000Z",
        landingVerification: "Current branch verified.",
      }),
      executionMode: "current-branch",
      checkoutPath: "/repo",
      branchName: "main",
      launchHead: "abc123",
      cleanupPolicy: undefined,
      worktreePath: undefined,
    } as unknown as WorkerRuntime;
    const currentBranchPendingWorker = {
      ...createWorker({
        status: "exited",
        ticketStatus: "closed",
      }),
      executionMode: "current-branch",
      checkoutPath: "/repo",
      branchName: "main",
      launchHead: "abc123",
      cleanupPolicy: undefined,
      worktreePath: undefined,
    } as unknown as WorkerRuntime;

    expect(getWorkerActionAvailability(heldWorker).land).toMatchObject({
      enabled: true,
      reason: "merge back the held worker branch",
    });
    expect(getWorkerActionAvailability(currentBranchPendingWorker).land).toMatchObject({
      enabled: true,
      reason: "run current-branch verification for this worker",
    });
    expect(getWorkerActionAvailability(currentBranchPendingWorker).land.reason).not.toContain(
      "merge-back",
    );
    expect(getWorkerActionAvailability(runningWorker).land).toMatchObject({
      enabled: false,
      reason: "worker is still active",
    });
    expect(getWorkerActionAvailability(runningWorker).cancel).toMatchObject({
      enabled: true,
      reason: "stop the active worker",
    });
    expect(getWorkerActionAvailability(manualCleanupWorker).cleanup).toMatchObject({
      enabled: true,
      reason: "remove retained worktree/runtime artifacts",
    });
    expect(getWorkerActionAvailability(autoCleanupWorker).cleanup).toMatchObject({
      enabled: false,
      reason: "cleanup policy is cleanup-after-landing",
    });
    expect(getWorkerActionAvailability(verifiedWorker).land).toMatchObject({
      enabled: false,
      reason: "already verified",
    });
    expect(getWorkerActionAvailability(verifiedWorker).cancel).toMatchObject({
      enabled: false,
      reason: "only launching/running workers can be cancelled",
    });
    expect(getWorkerActionAvailability(verifiedWorker).cleanup).toMatchObject({
      enabled: true,
      reason: "remove retained runtime artifacts",
    });
  });

  it("surfaces grouped worker detail lines with paths and action lane state", () => {
    const worker = createWorker({
      status: "held",
      ticketStatus: "closed",
      validationStatus: "passed",
      landingAheadCount: 2,
      landingBehindCount: 0,
      landingVerification: "Validated and held. Ready to land.",
    });

    const lines = buildWorkerManagerPanelLines({
      workers: [worker],
      state: {
        mode: "interactive",
        scope: { kind: "epic", id: "BW-100", title: "Epic" },
        updatedAt: "2026-04-14T00:00:00.000Z",
      },
      selectedWorkerId: worker.workerId,
    });
    const text = lines.join("\n");

    expect(text).toContain("Epic BW-100 (current scope)");
    expect(text).toContain("Task");
    expect(text).toContain("held · ticket closed");
    expect(text).toContain("Next: Validated and held. Run /bw land BW-101 when");
    expect(text).toContain("you're ready to merge-back.");
    expect(text).not.toContain("Ops");
    expect(text).toContain("tmux: pi-bw:bw-101.%42");
    expect(text).toContain("log: worker.log");
    expect(text).toContain("worktree: worktree");
  });
});
