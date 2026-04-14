import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BeadworkAdapter } from "../../bw.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import { buildWorkerAgentCommand, runBoundedEpicLoop, stopWorkers } from "../../orchestrator.js";
import { resolveWorkerRegistryPath, saveWorkerRegistry } from "../../registry.js";
import type { BeadworkIssueDetail, WorkerRuntime } from "../../types.js";

function createIssue(overrides: Partial<BeadworkIssueDetail> = {}): BeadworkIssueDetail {
  return {
    id: "BW-100",
    title: "Epic",
    description: "",
    status: "open",
    type: "epic",
    priority: 2,
    labels: [],
    blockedBy: [],
    blocks: [],
    assignee: "",
    createdAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:00.000Z",
    children: [],
    ...overrides,
  };
}

function createAdapter(overrides: Partial<BeadworkAdapter>): BeadworkAdapter {
  return {
    prime: vi.fn(),
    ready: vi.fn(),
    blocked: vi.fn(),
    list: vi.fn(),
    show: vi.fn(),
    createIssue: vi.fn(),
    addDependency: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    sync: vi.fn(),
    getCounts: vi.fn(),
    ...overrides,
  } as BeadworkAdapter;
}

function createWorker(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  return {
    workerId: "bw-101-worker",
    ticketId: "BW-101",
    epicId: "BW-100",
    ticketTitle: "Task",
    ticketStatus: "open",
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
    status: "exited",
    startedAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:01.000Z",
    ...overrides,
  };
}

describe("orchestrator helpers", () => {
  it("appends worker provider and model flags without changing defaults", () => {
    expect(buildWorkerAgentCommand(DEFAULT_CONFIG)).toBe("pi");
    expect(
      buildWorkerAgentCommand({
        ...DEFAULT_CONFIG,
        tmux: {
          ...DEFAULT_CONFIG.tmux,
          workerProvider: "openai",
          workerModel: "gpt-5.4",
        },
      }),
    ).toBe("pi --provider 'openai' --model 'gpt-5.4'");
  });

  it("stops active workers and persists the updated runtime state", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-stop-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [createWorker({ status: "running" })]);

    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn(),
      cleanupWorker: vi.fn().mockResolvedValue(undefined),
    };

    const stopped = await stopWorkers({
      repoRoot,
      config: DEFAULT_CONFIG,
      epicId: "BW-100",
      tmuxBackend,
      reason: "Stopped by test.",
    });

    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.status).toBe("exited");
    expect(stopped[0]?.lastError).toBe("Stopped by test.");
    expect(tmuxBackend.cleanupWorker).toHaveBeenCalledWith({
      paneId: "%42",
      sessionName: "pi-bw",
      windowName: "bw-101",
    });
  });
});

describe("run loop", () => {
  it("stops as blocked when no scoped ready work exists", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-"));
    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(
        createIssue({
          children: [createIssue({ id: "BW-101", type: "task", title: "Task" })],
        }),
      ),
      ready: vi.fn().mockResolvedValue([]),
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: DEFAULT_CONFIG,
      adapter,
      epicId: "BW-100",
      options: {
        workers: 1,
        until: "blocked",
        dryRun: false,
        maxCycles: 1,
        pollIntervalMs: 0,
        noSpawn: false,
      },
    });

    expect(summary.stopReason).toBe("blocked");
    expect(summary.cycles).toBe(1);
  });

  it("stops for attention when ready work was already attempted", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [createWorker()]);

    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(
        createIssue({
          children: [createIssue({ id: "BW-101", type: "task", title: "Task" })],
        }),
      ),
      ready: vi
        .fn()
        .mockResolvedValue([
          createIssue({ id: "BW-101", type: "task", title: "Task", children: [] }),
        ]),
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: DEFAULT_CONFIG,
      adapter,
      epicId: "BW-100",
      options: {
        workers: 1,
        until: "blocked",
        dryRun: false,
        maxCycles: 2,
        pollIntervalMs: 0,
        noSpawn: false,
      },
    });

    expect(summary.stopReason).toBe("attention");
    expect(summary.notes[0]).toContain("human review is needed");
  });
});
