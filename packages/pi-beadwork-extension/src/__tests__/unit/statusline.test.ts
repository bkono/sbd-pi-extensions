import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../constants.js";
import { summarizeWorkers } from "../../registry.js";
import { renderStatusText } from "../../statusline.js";
import type { WorkerRuntime } from "../../types.js";
import { createFakeExtensionContext, createFakeUi } from "../helpers/extension-harness.js";

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
  } as WorkerRuntime;
}

describe("statusline", () => {
  it("renders mode and scope without worker counts", () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui });
    const statusText = renderStatusText(
      ctx,
      { kind: "active", repoRoot: "/repo" },
      {
        mode: "run",
        scope: { kind: "epic", id: "BW-100", title: "Scoped epic" },
        updatedAt: "now",
        trackedWorkerIds: ["bw-101-worker"],
      },
      DEFAULT_CONFIG,
    );

    expect(statusText).toContain("bw");
    expect(statusText).toContain("run");
    expect(statusText).toContain("epic BW-100");
    expect(statusText).not.toContain("tracked");
    expect(statusText).not.toContain("workers");
    expect(statusText).not.toContain("held");
    expect(statusText).not.toContain("attention");
  });

  it("does not surface worker summaries even when they exist", () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui });
    const summary = summarizeWorkers([
      createWorker(),
      createWorker({ executionMode: "current-branch", workerId: "bw-102-worker" }),
    ]);
    expect(summary.active).toBe(2);

    const statusText = renderStatusText(
      ctx,
      { kind: "active", repoRoot: "/repo" },
      { mode: "interactive", scope: { kind: "none" }, updatedAt: "now" },
      DEFAULT_CONFIG,
    );

    expect(statusText).toBe("bw interactive");
    expect(statusText).not.toContain("current-branch");
    expect(statusText).not.toContain("worktree");
    expect(statusText).not.toMatch(/workers \d/);
  });
});
