import { describe, expect, it } from "vitest";
import { formatStatusLines, showWorkers } from "../../commands.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import { summarizeWorkers } from "../../registry.js";
import { renderStatusText } from "../../statusline.js";
import { buildWorkerManagerPanelLines } from "../../tui/worker-manager.js";
import type { WorkerRuntime } from "../../types.js";
import { formatWorkerInspectionLines, inspectWorker } from "../../worker-diagnostics.js";
import { createFakeExtensionContext, createFakeUi } from "../helpers/extension-harness.js";

function createWorker(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  const executionMode = overrides.executionMode ?? "worktree";
  const worktreePath = overrides.worktreePath ?? "/tmp/worktree";
  const checkoutPath = overrides.checkoutPath ?? worktreePath;
  return {
    workerId: overrides.workerId ?? "bw-101-worker",
    ticketId: overrides.ticketId ?? "BW-101",
    epicId: overrides.epicId ?? "BW-100",
    ticketTitle: overrides.ticketTitle ?? "Task",
    ticketStatus: overrides.ticketStatus ?? "open",
    executionMode,
    checkoutPath,
    branchName: overrides.branchName ?? "BW-101/task",
    ...(executionMode === "current-branch"
      ? { launchHead: overrides.launchHead ?? "abc123" }
      : { worktreePath }),
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
    status: overrides.status ?? "running",
    startedAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:01.000Z",
    ...overrides,
  } as WorkerRuntime;
}

describe("worker execution mode labels", () => {
  it("shows mode badges and detail fields for both execution modes", () => {
    const worktree = createWorker();
    const currentBranch = createWorker({
      workerId: "bw-102-worker",
      ticketId: "BW-102",
      executionMode: "current-branch",
      checkoutPath: "/repo",
      branchName: "main",
      launchHead: "def456",
      worktreePath: undefined,
    });

    const workersText = [
      ...formatWorkerInspectionLines(inspectWorker(worktree)),
      ...formatWorkerInspectionLines(inspectWorker(currentBranch)),
    ].join("\n");
    expect(workersText).toContain("BW-101 [worktree]");
    expect(workersText).toContain("BW-102 [current-branch]");

    const managerText = buildWorkerManagerPanelLines({
      workers: [worktree, currentBranch],
      state: { mode: "interactive", scope: { kind: "none" }, updatedAt: "now" },
      selectedWorkerId: currentBranch.workerId,
    }).join("\n");
    expect(managerText).toContain("BW-101 [worktree]");
    expect(managerText).toContain("BW-102 [current-branch]");
    expect(managerText).toContain("executionMode: current-branch");
    expect(managerText).toContain("checkoutPath: /repo");
    expect(managerText).toContain("branchName: main");
    expect(managerText).toContain("launchHead: def456");
  });

  it("counts mixed execution modes in aggregate and statusline output", async () => {
    const workers = [createWorker(), createWorker({ executionMode: "current-branch" })];
    const summary = summarizeWorkers(workers);
    expect(summary.worktree).toBe(1);
    expect(summary.currentBranch).toBe(1);
    expect(summary.activeWorktree).toBe(1);
    expect(summary.activeCurrentBranch).toBe(1);

    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui });
    await showWorkers(ctx, workers);
    expect(ui.notifications.at(-1)?.message).toContain("modes current-branch=1 worktree=1");

    const statusText = renderStatusText(
      ctx,
      { kind: "active", repoRoot: "/repo" },
      { mode: "interactive", scope: { kind: "none" }, updatedAt: "now" },
      DEFAULT_CONFIG,
      summary,
    );
    expect(statusText).toContain("current-branch 1 worktree 1");
  });

  it("shows configured default execution mode in /bw status text", () => {
    const lines = formatStatusLines({
      activation: { kind: "active", repoRoot: "/repo" },
      state: { mode: "interactive", scope: { kind: "none" }, updatedAt: "now" },
      config: {
        ...DEFAULT_CONFIG,
        workerExecution: { ...DEFAULT_CONFIG.workerExecution, mode: "current-branch" },
      },
    });
    expect(lines).toContain("Default execution mode: current-branch");
  });
});
