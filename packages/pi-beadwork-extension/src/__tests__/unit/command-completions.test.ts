import { describe, expect, it, vi } from "vitest";
import { createBeadworkCommandCompletionFactory } from "../../command-completions.js";
import type { WorkerRuntime } from "../../types.js";

function worker(overrides: Partial<WorkerRuntime>): WorkerRuntime {
  return {
    executionMode: "worktree",
    checkoutPath: "/tmp/worktree",
    branchName: "BW-200/task",
    worktreePath: "/tmp/worktree",
    workerId: "bw-200-worker",
    ticketId: "BW-200",
    ticketTitle: "Task",
    backend: "tmux",
    tmuxSession: "pi-bw",
    tmuxWindow: "bw-200",
    tmuxPane: "%1",
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
    startedAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

function currentBranchWorker(overrides: Partial<WorkerRuntime>): WorkerRuntime {
  const { cleanupPolicy: _cleanupPolicy, worktreePath: _worktreePath, ...base } = worker({});
  return {
    ...base,
    executionMode: "current-branch",
    checkoutPath: "/repo",
    branchName: "main",
    launchHead: "abc123",
    ...overrides,
  };
}

describe("beadwork command completions", () => {
  it("suggests subcommands for the main /bw command", async () => {
    const completions = createBeadworkCommandCompletionFactory({
      adapter: {
        ready: vi.fn(),
        list: vi.fn(),
      },
      detectActivation: vi.fn(),
      getCwd: () => "/repo",
    });

    const items = await completions.getMainCommandCompletions("de");
    expect(items?.map((item) => item.value)).toContain("delegate");
    expect(items?.map((item) => item.value)).not.toContain("run");
  });

  it("offers ready non-epic tickets for /bw:delegate completions", async () => {
    const adapter = {
      ready: vi.fn().mockResolvedValue([
        {
          id: "BW-100",
          title: "Epic",
          description: "",
          status: "open",
          type: "epic",
          priority: 1,
          labels: [],
          blockedBy: [],
          blocks: [],
          assignee: "",
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "BW-101",
          title: "Task",
          description: "",
          status: "open",
          type: "task",
          priority: 2,
          labels: [],
          blockedBy: [],
          blocks: [],
          assignee: "",
          createdAt: "",
          updatedAt: "",
        },
      ]),
      list: vi.fn(),
    };
    const completions = createBeadworkCommandCompletionFactory({
      adapter,
      detectActivation: vi.fn().mockResolvedValue({ kind: "active", repoRoot: "/repo" }),
      getCwd: () => "/repo",
    });

    const items = await completions.getAliasCommandCompletions("delegate", "BW-");
    expect(items).toEqual([
      {
        value: "BW-101",
        label: "BW-101 · open",
        description: "Task",
      },
    ]);
  });

  it("offers cleanup completions for landed worktree and verified current-branch workers", async () => {
    const completions = createBeadworkCommandCompletionFactory({
      adapter: {
        ready: vi.fn(),
        list: vi.fn(),
      },
      detectActivation: vi.fn().mockResolvedValue({ kind: "active", repoRoot: "/repo" }),
      getCwd: () => "/repo",
      getWorkers: vi.fn().mockResolvedValue([
        worker({ workerId: "bw-201-worker", ticketId: "BW-201", status: "landed" }),
        currentBranchWorker({
          workerId: "bw-202-worker",
          ticketId: "BW-202",
          status: "verified",
        }),
        currentBranchWorker({
          workerId: "bw-203-worker",
          ticketId: "BW-203",
          status: "verified",
          cleanupStatus: "cleaned",
        }),
        worker({ workerId: "bw-204-worker", ticketId: "BW-204", status: "verified" }),
        currentBranchWorker({
          workerId: "bw-205-worker",
          ticketId: "BW-205",
          status: "landed",
        }),
      ]),
    });

    const items = await completions.getAliasCommandCompletions("cleanup", "BW-");

    expect(items?.map((item) => item.value)).toEqual(["BW-201", "BW-202"]);
  });
});
