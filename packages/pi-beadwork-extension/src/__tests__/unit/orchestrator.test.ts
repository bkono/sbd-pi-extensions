import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BeadworkAdapter } from "../../bw.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import {
  buildWorkerAgentCommand,
  inspectWorkerRuntime,
  runBoundedEpicLoop,
  stopWorkers,
} from "../../orchestrator.js";
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
  it("forces pi workers into print mode before appending provider/model flags", () => {
    expect(buildWorkerAgentCommand(DEFAULT_CONFIG)).toBe("pi --print");
    expect(
      buildWorkerAgentCommand({
        ...DEFAULT_CONFIG,
        tmux: {
          ...DEFAULT_CONFIG.tmux,
          workerProvider: "openai",
          workerModel: "gpt-5.4",
        },
      }),
    ).toBe("pi --print --provider 'openai' --model 'gpt-5.4'");
    expect(
      buildWorkerAgentCommand({
        ...DEFAULT_CONFIG,
        tmux: {
          ...DEFAULT_CONFIG.tmux,
          workerCommand: "pi --print",
        },
      }),
    ).toBe("pi --print");
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

describe("worker inspection", () => {
  it("auto-validates, lands, and cleans up a completed worker", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-land-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });
    await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));

    const worker = createWorker({
      worktreePath,
      ticketStatus: "closed",
      cleanupPolicy: "cleanup-after-landing",
      cleanupStatus: "pending",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi
        .fn()
        .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
    });

    let repoHead = "repo-head";
    let workerHead = "worker-head";
    let diverged = true;
    let merged = false;
    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: `${repoHead}\n`, stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: `${workerHead}\n`, stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-list") {
        return {
          stdout: merged ? "0 0\n" : diverged ? "1 2\n" : "0 2\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "merge-base") {
        return { stdout: "merge-base\n", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1]?.includes("git diff --binary")) {
        throw new Error("reverse apply failed");
      }
      if (command === "git" && args[0] === "rebase") {
        diverged = false;
        workerHead = "worker-rebased";
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run lint") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run test") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run typecheck") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "merge") {
        repoHead = workerHead;
        merged = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
      cleanupWorker: vi.fn().mockResolvedValue(undefined),
    };

    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: DEFAULT_CONFIG,
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("landed");
    expect(inspected.validationStatus).toBe("passed");
    expect(inspected.cleanupStatus).toBe("cleaned");
    expect(inspected.landingVerifiedAt).toBeTruthy();
    expect(inspected.lastError).toBeUndefined();
    expect(tmuxBackend.cleanupWorker).toHaveBeenCalled();
  });

  it("validates already-contained worker heads before marking them landed", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-contained-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      ticketStatus: "closed",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi
        .fn()
        .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
    });

    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: "repo-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { stdout: "2 0\n", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run lint") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run test") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run typecheck") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
      cleanupWorker: vi.fn().mockResolvedValue(undefined),
    };

    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: DEFAULT_CONFIG,
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("landed");
    expect(inspected.validationStatus).toBe("passed");
    expect(inspected.validationSummary).toContain("Validation passed");
    expect(inspected.landingVerifiedAt).toBeTruthy();
  });

  it("revalidates legacy landed workers when validation is still pending", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-landed-pending-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      ticketStatus: "closed",
      status: "landed",
      validationStatus: "pending",
      landingVerifiedAt: "2026-04-14T01:00:00.000Z",
      landingVerification:
        "Landing verified: worktree is clean and worker HEAD is fully contained in repo HEAD.",
      landingAheadCount: 0,
      landingBehindCount: 2,
    });

    const adapter = createAdapter({
      show: vi
        .fn()
        .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
    });

    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: "repo-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { stdout: "2 0\n", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run lint") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run test") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run typecheck") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
      cleanupWorker: vi.fn().mockResolvedValue(undefined),
    };

    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: DEFAULT_CONFIG,
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("landed");
    expect(inspected.validationStatus).toBe("passed");
    expect(inspected.validationSummary).toContain("Validation passed");
  });

  it("moves completed workers into attention when validation fails", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-land-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      ticketStatus: "closed",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi
        .fn()
        .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
    });

    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: "repo-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { stdout: "0 2\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "merge-base") {
        return { stdout: "merge-base\n", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1]?.includes("git diff --binary")) {
        throw new Error("reverse apply failed");
      }
      if (command === "bash" && args[1] === "npm run lint") {
        throw new Error("lint failed");
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
      cleanupWorker: vi.fn().mockResolvedValue(undefined),
    };

    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: DEFAULT_CONFIG,
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("attention");
    expect(inspected.validationStatus).toBe("failed");
    expect(inspected.lastError).toContain("npm run lint");
  });

  it("refreshes closed ticket status even while the worker process is still running", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-running-worker-"));
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    const stateFile = path.join(runtimeDir, "state.txt");
    const exitCodeFile = path.join(runtimeDir, "exit-code.txt");
    const finishedAtFile = path.join(runtimeDir, "finished-at.txt");
    await writeFile(stateFile, "running\n", "utf8");

    const worker = createWorker({
      status: "running",
      ticketStatus: "open",
      runtimeDir,
      stateFile,
      exitCodeFile,
      finishedAtFile,
    });

    const adapter = createAdapter({
      show: vi
        .fn()
        .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
    });

    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn().mockResolvedValue({
        exists: true,
        sessionName: "pi-bw",
        windowName: "bw-101",
        paneId: "%7",
        dead: false,
        currentCommand: "pi",
      }),
      cleanupWorker: vi.fn().mockResolvedValue(undefined),
    };

    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      tmuxBackend,
    });

    expect(inspected.status).toBe("running");
    expect(inspected.ticketStatus).toBe("closed");
    expect(inspected.tmuxPane).toBe("%7");
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
    expect(summary.notes[0]).toContain("needs operator attention");
  });
});
