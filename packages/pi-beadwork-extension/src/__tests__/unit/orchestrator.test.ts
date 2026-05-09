import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BeadworkAdapter } from "../../bw.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import {
  buildReviewerAgentCommand,
  buildWorkerAgentCommand,
  inspectWorkerRuntime,
  launchTicketWorker,
  requestWorkerLanding,
  runBoundedEpicLoop,
  stopWorkers,
} from "../../orchestrator.js";
import { ProcessCommandError } from "../../process.js";
import {
  loadWorkerRegistry,
  resolveWorkerRegistryPath,
  saveWorkerRegistry,
} from "../../registry.js";
import { createTmuxBackend, type TmuxBackend } from "../../tmux.js";
import type { BeadworkIssueDetail, WorkerRuntime } from "../../types.js";

const itInTmuxSession = process.env.TMUX?.trim() ? it : it.skip;

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
    status: "exited",
    startedAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:01.000Z",
    ...overrides,
  };
}

function ok(stdout = "") {
  return { stdout, stderr: "", exitCode: 0 };
}

function createMockTmuxBackend(): TmuxBackend {
  return {
    ensureSession: vi.fn().mockResolvedValue({ sessionName: "pi-bw", created: false }),
    launchWorker: vi.fn(async (input) => ({
      sessionName: input.sessionName,
      windowName: `${input.workerId}-window`,
      paneId: "%42",
      launchCommand: input.launchCommand,
    })),
    inspectWorker: vi.fn().mockResolvedValue({ exists: true }),
    cleanupWorker: vi.fn().mockResolvedValue(undefined),
  };
}

function createLaunchAdapter(
  ticket: BeadworkIssueDetail,
  epic?: BeadworkIssueDetail,
): BeadworkAdapter {
  return createAdapter({
    show: vi.fn(async (_cwd: string, id: string) => {
      if (id === ticket.id) {
        return ticket;
      }
      if (epic && id === epic.id) {
        return epic;
      }
      throw new Error(`unexpected issue ${id}`);
    }),
  });
}

describe("launchTicketWorker", () => {
  it("launches current-branch workers at the repo root without worktree-only fields", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-bw-launch-current-"));
    const repoRoot = path.join(tmp, "repo");
    await mkdir(repoRoot, { recursive: true });
    const ticket = createIssue({
      id: "BW-201",
      title: "Current branch task",
      type: "task",
      status: "open",
      parentId: "BW-200",
    });
    const epic = createIssue({ id: "BW-200", title: "Launch epic", type: "epic" });
    const tmuxBackend = createMockTmuxBackend();
    const processRunner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return ok("feature/shared\n");
      }
      if (command === "git" && args.join(" ") === "rev-parse HEAD") {
        return ok("abc123launch\n");
      }
      throw new Error(`unexpected process call: ${command} ${args.join(" ")}`);
    });

    const worker = await launchTicketWorker({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        workerExecution: { ...DEFAULT_CONFIG.workerExecution, mode: "current-branch" },
        worktrees: { ...DEFAULT_CONFIG.worktrees, cleanup: "cleanup-after-landing" },
      },
      adapter: createLaunchAdapter(ticket, epic),
      ticketId: ticket.id,
      tmuxBackend,
      processRunner,
    });

    expect(tmuxBackend.launchWorker).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: repoRoot }),
    );
    expect(processRunner.mock.calls.map((call) => call[1].join(" "))).not.toContain("worktree add");
    expect(processRunner).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["status"]),
      expect.anything(),
    );
    expect(existsSync(worker.runtimeDir)).toBe(true);
    expect(existsSync(path.join(worker.runtimeDir, "scratch"))).toBe(true);
    expect(worker.executionMode).toBe("current-branch");
    expect(worker.checkoutPath).toBe(repoRoot);
    expect(worker.branchName).toBe("feature/shared");
    expect(worker.launchHead).toBe("abc123launch");
    expect("worktreePath" in worker).toBe(false);
    expect(worker.cleanupPolicy).toBeUndefined();
    expect(worker.cleanupStatus).toBeUndefined();

    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    const records = await loadWorkerRegistry(registryPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workerId: worker.workerId,
      executionMode: "current-branch",
      checkoutPath: repoRoot,
      branchName: "feature/shared",
      launchHead: "abc123launch",
    });
    expect("worktreePath" in records[0]).toBe(false);
  });

  it("preserves worktree launch behavior and registry records", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-bw-launch-worktree-"));
    const repoRoot = path.join(tmp, "repo");
    const worktreeBase = path.join(tmp, "worktrees");
    await mkdir(repoRoot, { recursive: true });
    const ticket = createIssue({ id: "BW-202", title: "Worktree task", type: "task" });
    const tmuxBackend = createMockTmuxBackend();
    const processRunner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "branch") {
        return ok("");
      }
      if (command === "git" && args[0] === "worktree" && args[1] === "add") {
        return ok("");
      }
      throw new Error(`unexpected process call: ${command} ${args.join(" ")}`);
    });

    const worker = await launchTicketWorker({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        worktrees: {
          ...DEFAULT_CONFIG.worktrees,
          baseDir: worktreeBase,
          cleanup: "cleanup-after-landing",
        },
      },
      adapter: createLaunchAdapter(ticket),
      ticketId: ticket.id,
      tmuxBackend,
      processRunner,
    });

    expect(worker.executionMode).toBe("worktree");
    expect(worker.worktreePath).toBe(worker.checkoutPath);
    expect(worker.worktreePath).toContain(worktreeBase);
    expect(worker.cleanupPolicy).toBe("cleanup-after-landing");
    expect(worker.cleanupStatus).toBe("pending");
    expect(tmuxBackend.launchWorker).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: worker.worktreePath }),
    );
    expect(processRunner.mock.calls.some((call) => call[1][0] === "worktree")).toBe(true);

    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    const records = await loadWorkerRegistry(registryPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workerId: worker.workerId,
      executionMode: "worktree",
      checkoutPath: worker.worktreePath,
      worktreePath: worker.worktreePath,
      cleanupPolicy: "cleanup-after-landing",
      cleanupStatus: "pending",
    });
  });

  it("records current-branch launch failures with checkout metadata", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-launch-current-fail-"));
    const ticket = createIssue({ id: "BW-203", title: "Current branch fail", type: "task" });
    const tmuxBackend = createMockTmuxBackend();
    vi.mocked(tmuxBackend.launchWorker).mockRejectedValueOnce(new Error("tmux pane denied"));
    const processRunner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return ok("main\n");
      }
      if (command === "git" && args.join(" ") === "rev-parse HEAD") {
        return ok("head123\n");
      }
      throw new Error(`unexpected process call: ${command} ${args.join(" ")}`);
    });

    await expect(
      launchTicketWorker({
        cwd: repoRoot,
        repoRoot,
        config: {
          ...DEFAULT_CONFIG,
          workerExecution: { ...DEFAULT_CONFIG.workerExecution, mode: "current-branch" },
        },
        adapter: createLaunchAdapter(ticket),
        ticketId: ticket.id,
        tmuxBackend,
        processRunner,
      }),
    ).rejects.toThrow(/Failed to launch worker .* for BW-203 /);

    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    const records = await loadWorkerRegistry(registryPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      executionMode: "current-branch",
      checkoutPath: repoRoot,
      branchName: "main",
      launchHead: "head123",
      status: "failed",
    });
    expect(records[0]?.lastError).toContain(
      `executionMode=current-branch checkoutPath=${repoRoot} branchName=main launchHead=head123`,
    );
    expect(records[0]?.lastError).toContain("tmux pane denied");
  });

  it("records worktree launch failures with worktree metadata", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-bw-launch-worktree-fail-"));
    const repoRoot = path.join(tmp, "repo");
    const worktreeBase = path.join(tmp, "worktrees");
    await mkdir(repoRoot, { recursive: true });
    const ticket = createIssue({ id: "BW-204", title: "Worktree fail", type: "task" });
    const tmuxBackend = createMockTmuxBackend();
    vi.mocked(tmuxBackend.launchWorker).mockRejectedValueOnce(new Error("tmux pane denied"));
    const processRunner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "branch") {
        return ok("");
      }
      if (command === "git" && args[0] === "worktree" && args[1] === "add") {
        return ok("");
      }
      throw new Error(`unexpected process call: ${command} ${args.join(" ")}`);
    });

    await expect(
      launchTicketWorker({
        cwd: repoRoot,
        repoRoot,
        config: {
          ...DEFAULT_CONFIG,
          worktrees: { ...DEFAULT_CONFIG.worktrees, baseDir: worktreeBase },
        },
        adapter: createLaunchAdapter(ticket),
        ticketId: ticket.id,
        tmuxBackend,
        processRunner,
      }),
    ).rejects.toThrow("executionMode=worktree worktreePath=");

    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    const records = await loadWorkerRegistry(registryPath);
    expect(records).toHaveLength(1);
    const failed = records[0] as WorkerRuntime;
    expect(failed).toMatchObject({ executionMode: "worktree", status: "failed" });
    expect(failed.lastError).toContain(
      `executionMode=worktree worktreePath=${failed.worktreePath}`,
    );
    expect(failed.lastError).toContain("tmux pane denied");
  });
});

describe("orchestrator helpers", () => {
  it("normalizes pi workers into a valid mode before appending provider/model flags", () => {
    expect(buildWorkerAgentCommand(DEFAULT_CONFIG)).toBe("pi --mode json");
    expect(
      buildWorkerAgentCommand({
        ...DEFAULT_CONFIG,
        tmux: {
          ...DEFAULT_CONFIG.tmux,
          workerProvider: "openai",
          workerModel: "gpt-5.4",
        },
      }),
    ).toBe("pi --mode json --provider 'openai' --model 'gpt-5.4'");
    expect(
      buildWorkerAgentCommand({
        ...DEFAULT_CONFIG,
        tmux: {
          ...DEFAULT_CONFIG.tmux,
          workerCommand: "pi --print",
        },
      }),
    ).toBe("pi --mode json");
    expect(
      buildWorkerAgentCommand({
        ...DEFAULT_CONFIG,
        tmux: {
          ...DEFAULT_CONFIG.tmux,
          workerCommand: "pi --print --mode text",
        },
      }),
    ).toBe("pi --mode text");
  });

  it("builds reviewer commands with independently configurable provider/model", () => {
    expect(buildReviewerAgentCommand(DEFAULT_CONFIG)).toBe("pi --mode json");

    expect(
      buildReviewerAgentCommand({
        ...DEFAULT_CONFIG,
        tmux: {
          ...DEFAULT_CONFIG.tmux,
          workerProvider: "anthropic",
          workerModel: "claude-sonnet",
        },
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            provider: "openai",
            model: "gpt-5.4-reviewer",
          },
        },
      }),
    ).toBe("pi --mode json --provider 'openai' --model 'gpt-5.4-reviewer'");
  });

  it("builds worker commands with a one-off provider/model override without mutating defaults", () => {
    const config = {
      ...DEFAULT_CONFIG,
      tmux: {
        ...DEFAULT_CONFIG.tmux,
        workerProvider: "openai",
        workerModel: "gpt-5.4",
      },
    };

    expect(
      buildWorkerAgentCommand(config, {
        workerProvider: "cursor",
        workerModel: "composer-2",
      }),
    ).toBe("pi --mode json --provider 'cursor' --model 'composer-2'");
    expect(config.tmux.workerProvider).toBe("openai");
    expect(config.tmux.workerModel).toBe("gpt-5.4");
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
    const runtimeRoot = path.join(repoRoot, ".pi", "beadwork", "workers", "runtime");
    const runtimeDir = path.join(runtimeRoot, "bw-101-worker");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "worker.log"), "worker output\n", "utf8");

    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      launchCommand: `bash ${path.join(runtimeDir, "launch.sh")}`,
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
    expect(existsSync(runtimeDir)).toBe(false);
  });

  it("still removes landed runtime artifacts when tmux teardown reports the worker window is already gone", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-landed-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeRoot = path.join(repoRoot, ".pi", "beadwork", "workers", "runtime");
    const runtimeDir = path.join(runtimeRoot, "bw-101-worker");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "worker.log"), "worker output\n", "utf8");

    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      launchCommand: `bash ${path.join(runtimeDir, "launch.sh")}`,
      cleanupPolicy: "cleanup-after-landing",
      cleanupStatus: "pending",
      validationStatus: "passed",
      ticketStatus: "closed",
    });

    const adapter = createAdapter({
      show: vi
        .fn()
        .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
    });

    let repoHead = "repo-head";
    const workerHead = "worker-head";
    let merged = false;
    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "tmux" && args[0] === "kill-window") {
        throw new ProcessCommandError({
          command,
          args,
          code: 1,
          stderr: "can't find pane: pi-bw:bw-101",
        });
      }
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
        return { stdout: merged ? "0 0\n" : "0 2\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "merge-base") {
        return { stdout: "merge-base\n", stderr: "", code: 0 };
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

    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: DEFAULT_CONFIG,
      tmuxBackend: createTmuxBackend(runner),
      runner,
    });

    expect(inspected.status).toBe("landed");
    expect(inspected.cleanupStatus).toBe("cleaned");
    expect(inspected.lastError).toBeUndefined();
    expect(existsSync(runtimeDir)).toBe(false);
  });

  it("holds a validated worker in deferred mode instead of auto-merging", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-held-worker-"));
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
        throw new Error("merge should not run in deferred mode");
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
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          policy: "deferred",
        },
      },
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("held");
    expect(inspected.validationStatus).toBe("passed");
    expect(inspected.landingVerification).toContain("Validated and held");
    expect(inspected.landingHeldAt).toBeTruthy();
  });

  it("runs reviewer gating before holding deferred workers", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-deferred-review-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(
        createIssue({
          id: "BW-101",
          type: "task",
          status: "closed",
          title: "Task",
          description: "Gate deferred landing on reviewer approval.",
          children: [],
        }),
      ),
    });

    const timeline: string[] = [];
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
      if (command === "git" && args[0] === "log") {
        return { stdout: "abc123 feat: deferred review gate\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "diff") {
        return { stdout: "diff --git a/orchestrator.ts b/orchestrator.ts\n", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run lint") {
        timeline.push("lint");
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run test") {
        timeline.push("test");
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run typecheck") {
        timeline.push("typecheck");
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1]?.includes("review-model")) {
        timeline.push("review");
        return {
          stdout: JSON.stringify({
            verdict: "approve",
            summary: "Deferred landing is safe to hold for explicit merge-back.",
            feedback: [],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "merge") {
        throw new Error("deferred landing should not merge automatically");
      }
      if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
        throw new Error("deferred landing should not clean up before explicit landing");
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
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          policy: "deferred",
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
          },
        },
        worktrees: {
          ...DEFAULT_CONFIG.worktrees,
          cleanup: "cleanup-after-landing",
        },
      },
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("held");
    expect(inspected.validationStatus).toBe("passed");
    expect(inspected.reviewStatus).toBe("approved");
    expect(inspected.reviewedWorkerHead).toBe("worker-head");
    expect(inspected.landingVerification).toContain("Reviewer approved");
    expect(timeline).toEqual(["lint", "test", "typecheck", "review"]);
    expect(tmuxBackend.cleanupWorker).not.toHaveBeenCalled();
  });

  it("records approve-with-nits reviewer outcomes before deferred holding", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-review-nits-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi.fn(async (_cwd, issueId) => {
        if (issueId === "BW-100") {
          return createIssue({ id: "BW-100", type: "epic", title: "Epic" });
        }
        return createIssue({
          id: "BW-101",
          type: "task",
          status: "closed",
          title: "Task",
          description: "Implement reviewer gating for delegated merge-back.",
          parentId: "BW-100",
          children: [],
        });
      }),
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
      if (command === "git" && args[0] === "log") {
        return { stdout: "abc123 feat: ticket change\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "diff") {
        return { stdout: "diff --git a/file b/file\n", stderr: "", code: 0 };
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
      if (command === "bash" && args[1]?.includes("gpt-5.4-reviewer")) {
        return {
          stdout: JSON.stringify({
            verdict: "approve-with-nits",
            summary: "Looks good overall; minor naming nit.",
            feedback: [
              {
                comment: "Consider renaming helper for readability.",
                intentAlignment: "aligned",
                requiresChanges: false,
              },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "merge") {
        throw new Error("merge should not run in deferred mode");
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
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          policy: "deferred",
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "gpt-5.4-reviewer",
          },
        },
      },
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("held");
    expect(inspected.reviewStatus).toBe("nits-only");
    expect(inspected.reviewVerdict).toBe("approve-with-nits");
    expect(inspected.landingVerification).toContain("Reviewer approved with non-blocking nits");
  });

  it("falls back to the launched worker provider/model for reviewer runs", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-review-worker-model-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      validationStatus: "pending",
      workerProvider: "cursor",
      workerModel: "composer-2",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi.fn(async (_cwd, issueId) => {
        if (issueId === "BW-100") {
          return createIssue({ id: "BW-100", type: "epic", title: "Epic" });
        }
        return createIssue({
          id: "BW-101",
          type: "task",
          status: "closed",
          title: "Task",
          description: "Verify reviewer fallback uses the launched worker override.",
          parentId: "BW-100",
          children: [],
        });
      }),
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
        return { stdout: "0 1\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "log") {
        return { stdout: "abc123 feat: worker override\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "diff") {
        return { stdout: "diff --git a/file b/file\n", stderr: "", code: 0 };
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
      if (command === "bash" && args[1]?.includes("--provider 'cursor' --model 'composer-2'")) {
        return {
          stdout: JSON.stringify({
            verdict: "approve",
            summary: "Looks good.",
            feedback: [],
          }),
          stderr: "",
          code: 0,
        };
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
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          policy: "deferred",
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
          },
        },
      },
      tmuxBackend,
      runner,
    });

    expect(inspected.reviewStatus).toBe("approved");
    expect(inspected.reviewerProvider).toBe("cursor");
    expect(inspected.reviewerModel).toBe("composer-2");
    expect(runner).toHaveBeenCalledWith(
      "bash",
      [expect.any(String), expect.stringContaining("--provider 'cursor' --model 'composer-2'")],
      expect.objectContaining({ cwd: worktreePath }),
    );
  });

  it("rejects out-of-scope reviewer feedback instead of blindly blocking landing", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-review-reject-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(
        createIssue({
          id: "BW-101",
          type: "task",
          status: "closed",
          title: "Task",
          description: "Implement reviewer gating in orchestrator flow.",
          children: [],
        }),
      ),
    });

    let merged = false;
    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: `${merged ? "worker-head" : "repo-head"}\n`, stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { stdout: `${merged ? "0 0" : "0 2"}\n`, stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "log") {
        return { stdout: "abc123 feat: reviewer gate\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "diff") {
        return { stdout: "diff --git a/orchestrator.ts b/orchestrator.ts\n", stderr: "", code: 0 };
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
      if (command === "bash" && args[1]?.includes("review-model")) {
        return {
          stdout: JSON.stringify({
            verdict: "request-changes",
            summary: "Rewrite this in Rust.",
            feedback: [
              {
                comment: "Port this TypeScript module to Rust.",
                intentAlignment: "misaligned",
                requiresChanges: true,
              },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "merge") {
        merged = true;
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
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
          },
        },
      },
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("landed");
    expect(inspected.reviewStatus).toBe("nits-only");
    expect(inspected.reviewVerdict).toBe("request-changes");
    expect(inspected.reviewInvalidFeedbackCount).toBe(1);
    expect(inspected.reviewSummary).toContain("no valid in-scope blockers");
  });

  it("runs bounded remediation and re-reviews when reviewer requests valid changes", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-review-remediate-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const initialWorker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(
        createIssue({
          id: "BW-101",
          type: "task",
          status: "closed",
          title: "Task",
          description: "Add reviewer gating with remediation and re-review.",
          children: [],
        }),
      ),
    });

    let merged = false;
    let reviewRuns = 0;
    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: `${merged ? "worker-head" : "repo-head"}\n`, stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { stdout: `${merged ? "0 0" : "0 2"}\n`, stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "log") {
        return { stdout: "abc123 feat: reviewer gate\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "diff") {
        return { stdout: "diff --git a/orchestrator.ts b/orchestrator.ts\n", stderr: "", code: 0 };
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
      if (command === "bash" && args[1]?.includes("review-model")) {
        reviewRuns += 1;
        if (reviewRuns === 1) {
          return {
            stdout: JSON.stringify({
              verdict: "request-changes",
              summary: "Needs clearer remediation status handling.",
              feedback: [
                {
                  comment: "Track remediation-in-progress state in worker diagnostics.",
                  intentAlignment: "aligned",
                  requiresChanges: true,
                },
              ],
            }),
            stderr: "",
            code: 0,
          };
        }

        return {
          stdout: JSON.stringify({
            verdict: "approve",
            summary: "Requested changes were addressed.",
            feedback: [],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "merge") {
        merged = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const tmuxBackend = {
      ensureSession: vi.fn().mockResolvedValue({ sessionName: "pi-bw", created: false }),
      launchWorker: vi.fn().mockResolvedValue({
        sessionName: "pi-bw",
        windowName: "bw-101-review-remediation",
        paneId: "%90",
        launchCommand: initialWorker.launchCommand,
      }),
      inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
      cleanupWorker: vi.fn().mockResolvedValue(undefined),
    };

    const onLifecycleEvent = vi.fn();
    const remediationStarted = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker: initialWorker,
      adapter,
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
            maxRemediationAttempts: 1,
          },
        },
      },
      tmuxBackend,
      runner,
      onLifecycleEvent,
    });

    expect(remediationStarted.status).toBe("running");
    expect(remediationStarted.reviewStatus).toBe("remediation-in-progress");
    expect(remediationStarted.reviewRemediationAttempts).toBe(1);
    expect(onLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "remediation-started", ticketId: "BW-101" }),
    );

    const remediationPrompt = await readFile(initialWorker.promptFile, "utf8");
    expect(remediationPrompt).toContain(
      "Mandatory validation commands to satisfy before handing back:",
    );
    expect(remediationPrompt).toContain("- npm run lint");
    expect(remediationPrompt).toContain("- npm run test");
    expect(remediationPrompt).toContain("- npm run typecheck");

    const rerunInput = {
      ...remediationStarted,
      status: "exited" as const,
      ticketStatus: "closed",
      finishedAt: "2026-04-14T01:05:00.000Z",
    };

    const landed = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker: rerunInput,
      adapter,
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
            maxRemediationAttempts: 1,
          },
        },
      },
      tmuxBackend,
      runner,
    });

    expect(landed.status).toBe("landed");
    expect(landed.reviewStatus).toBe("approved");
    expect(landed.reviewVerdict).toBe("approve");
    expect(reviewRuns).toBe(2);
  });

  it("parses structured reviewer handoffs from pi json-mode event streams after tool use", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-review-stream-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(
        createIssue({
          id: "BW-101",
          type: "task",
          status: "closed",
          title: "Task",
          description: "Return a structured review handoff from the reviewer stream.",
          children: [],
        }),
      ),
    });

    let merged = false;
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
        return { stdout: merged ? "0 0\n" : "0 1\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "log") {
        return { stdout: "abc123 feat: reviewer gate\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "diff") {
        return {
          stdout: "diff --git a/orchestrator.ts b/orchestrator.ts\n",
          stderr: "",
          code: 0,
        };
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
      if (command === "bash" && args[1]?.includes("review-model")) {
        return {
          stdout: [
            JSON.stringify({ type: "session" }),
            JSON.stringify({
              type: "message_start",
              message: { role: "assistant", content: [] },
            }),
            JSON.stringify({
              type: "message_update",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "I inspected the diff, checked downstream callsites, and reran the required commands.",
                  },
                ],
              },
            }),
            JSON.stringify({
              type: "message_update",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    toolCallId: "call-1",
                    toolName: "read",
                    arguments: { path: "README.md" },
                  },
                ],
              },
            }),
            JSON.stringify({
              type: "message_update",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "toolResult",
                    toolCallId: "call-1",
                    toolName: "read",
                    result: "README excerpt",
                  },
                ],
              },
            }),
            JSON.stringify({
              type: "message_update",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: 'Final handoff:\n<review_report>\n{\n  "verdict": "APPROVE WITH NITS",\n  "summary": "Looks good overall.",\n  "findings": [\n    {\n      "comment": "README examples could mention /om observations explicitly.",\n      "intentAlignment": "aligned",\n      "requiresChanges": false\n    }\n  ]\n}\n</review_report>',
                  },
                ],
              },
            }),
          ].join("\n"),
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "merge") {
        merged = true;
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
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
          },
        },
      },
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("landed");
    expect(inspected.reviewStatus).toBe("nits-only");
    expect(inspected.reviewVerdict).toBe("approve-with-nits");
    expect(inspected.reviewSummary).toContain("Looks good overall.");
  });

  it("streams reviewer output to review.log and preserves truthful timeout details", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-review-timeout-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(
        createIssue({
          id: "BW-101",
          type: "task",
          status: "closed",
          title: "Task",
          description: "Run a reviewer gate before delegated merge-back.",
          children: [],
        }),
      ),
    });

    const runner = vi.fn(
      async (
        command: string,
        args: string[],
        options?: {
          cwd?: string;
          onStdoutChunk?: (chunk: string) => void;
          onStderrChunk?: (chunk: string) => void;
        },
      ) => {
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
        if (command === "git" && args[0] === "log") {
          return { stdout: "abc123 feat: reviewer gate\n", stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return {
            stdout: "diff --git a/orchestrator.ts b/orchestrator.ts\n",
            stderr: "",
            code: 0,
          };
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
        if (command === "bash" && args[1]?.includes("review-model")) {
          options?.onStdoutChunk?.('{"partial":"review output"}\n');
          options?.onStderrChunk?.("still reviewing...\n");
          throw new ProcessCommandError({
            command,
            args,
            cwd: options?.cwd,
            code: 124,
            stdout: '{"partial":"review output"}\n',
            stderr: "still reviewing...\n",
            timedOut: true,
            killed: true,
            timeoutMs: 1_800_000,
          });
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    );

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
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
          },
        },
      },
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("attention");
    expect(inspected.reviewStatus).toBe("review-blocked");
    expect(inspected.lastError).toContain("timed out after 1800000ms");
    expect(inspected.reviewSummary).toContain("review.log");

    const reviewLog = await readFile(path.join(runtimeDir, "review.log"), "utf8");
    expect(reviewLog).toContain("[beadwork reviewer stdout]");
    expect(reviewLog).toContain('{"partial":"review output"}');
    expect(reviewLog).toContain("[beadwork reviewer stderr]");
    expect(reviewLog).toContain("still reviewing...");

    const workerLog = await readFile(worker.logFile, "utf8");
    expect(workerLog).toContain("running reviewer-agent gating pass before landing (log:");
  });

  it("serializes concurrent reviewer orchestration for the same worker", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-review-lock-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(
        createIssue({
          id: "BW-101",
          type: "task",
          status: "closed",
          title: "Task",
          description: "Run reviewer gating once per worker.",
          children: [],
        }),
      ),
    });

    let merged = false;
    let reviewRuns = 0;
    let resolveReviewStarted!: () => void;
    const reviewStarted = new Promise<void>((resolve) => {
      resolveReviewStarted = resolve;
    });
    let allowReviewToFinish!: () => void;
    const reviewCanFinish = new Promise<void>((resolve) => {
      allowReviewToFinish = resolve;
    });

    const runner = vi.fn(
      async (
        command: string,
        args: string[],
        options?: {
          cwd?: string;
          onStdoutChunk?: (chunk: string) => void;
          onStderrChunk?: (chunk: string) => void;
        },
      ) => {
        if (command === "git" && args[0] === "status") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
          return { stdout: `${merged ? "worker-head" : "repo-head"}\n`, stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
          return { stdout: "worker-head\n", stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "rev-list") {
          return { stdout: `${merged ? "0 0" : "0 2"}\n`, stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "log") {
          return { stdout: "abc123 feat: reviewer gate\n", stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return {
            stdout: "diff --git a/orchestrator.ts b/orchestrator.ts\n",
            stderr: "",
            code: 0,
          };
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
        if (command === "bash" && args[1]?.includes("review-model")) {
          reviewRuns += 1;
          resolveReviewStarted();
          await reviewCanFinish;
          return {
            stdout: JSON.stringify({
              verdict: "approve",
              summary: "Looks good.",
              feedback: [],
            }),
            stderr: "",
            code: 0,
          };
        }
        if (command === "git" && args[0] === "merge") {
          merged = true;
          return { stdout: "", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    );

    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
      cleanupWorker: vi.fn().mockResolvedValue(undefined),
    };

    const firstInspection = inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
          },
        },
      },
      tmuxBackend,
      runner,
    });

    await reviewStarted;

    const secondInspection = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
          },
        },
      },
      tmuxBackend,
      runner,
      awaitOrchestration: false,
    });

    expect(secondInspection.reviewStatus).toBe("pending");
    expect(secondInspection.reviewSummary).toContain("Reviewer gate is running before merge-back");
    expect(reviewRuns).toBe(1);

    allowReviewToFinish();
    const firstResult = await firstInspection;

    expect(firstResult.status).toBe("landed");
    expect(firstResult.reviewStatus).toBe("approved");
    expect(reviewRuns).toBe(1);
  });

  it("relaunches the worker to resolve a failed landing rebase and lands on retry", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-rebase-remediation-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const initialWorker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi
        .fn()
        .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
    });

    let phase: "rebase-fails" | "after-remediation" = "rebase-fails";
    let merged = false;
    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: `${merged ? "worker-remediated" : "repo-head"}\n`, stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return {
          stdout: `${phase === "after-remediation" ? "worker-remediated" : "worker-head"}\n`,
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "rev-list") {
        if (merged) {
          return { stdout: "0 0\n", stderr: "", code: 0 };
        }
        return {
          stdout: `${phase === "after-remediation" ? "0 1" : "1 1"}\n`,
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "rebase") {
        throw new Error("CONFLICT (content): Merge conflict in src/orchestrator.ts");
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
        merged = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const tmuxBackend = {
      ensureSession: vi.fn().mockResolvedValue({ sessionName: "pi-bw", created: false }),
      launchWorker: vi.fn().mockResolvedValue({
        sessionName: "pi-bw",
        windowName: "bw-101-rebase-remediation",
        paneId: "%90",
        launchCommand: initialWorker.launchCommand,
      }),
      inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
      cleanupWorker: vi.fn().mockResolvedValue(undefined),
    };

    const onLifecycleEvent = vi.fn();
    const remediationStarted = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker: initialWorker,
      adapter,
      config: DEFAULT_CONFIG,
      tmuxBackend,
      runner,
      onLifecycleEvent,
    });

    expect(remediationStarted.status).toBe("running");
    expect(remediationStarted.landingRemediationAttempts).toBe(1);
    expect(remediationStarted.reviewedWorkerHead).toBeUndefined();
    expect(onLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "remediation-started", ticketId: "BW-101" }),
    );

    const remediationPrompt = await readFile(initialWorker.promptFile, "utf8");
    expect(remediationPrompt).toContain("The orchestrator attempted to rebase");
    expect(remediationPrompt).toContain("context.md");

    phase = "after-remediation";
    const landed = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker: {
        ...remediationStarted,
        status: "exited",
        ticketStatus: "closed",
        finishedAt: "2026-04-14T01:05:00.000Z",
      },
      adapter,
      config: DEFAULT_CONFIG,
      tmuxBackend,
      runner,
    });

    expect(landed.status).toBe("landed");
    expect(landed.validationStatus).toBe("passed");
    expect(landed.landingRemediationAttempts).toBe(1);
    expect(tmuxBackend.launchWorker).toHaveBeenCalledTimes(1);
  });

  it("reruns reviewer gating after landing rebase remediation before merge-back", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-review-rebase-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const initialWorker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(
        createIssue({
          id: "BW-101",
          type: "task",
          status: "closed",
          title: "Task",
          description: "Review landing again after rebase remediation changes the worker head.",
          children: [],
        }),
      ),
    });

    let phase: "rebase-fails" | "after-remediation" = "rebase-fails";
    let merged = false;
    const timeline: string[] = [];
    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: `${merged ? "worker-remediated" : "repo-head"}\n`, stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return {
          stdout: `${phase === "after-remediation" ? "worker-remediated" : "worker-head"}\n`,
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "rev-list") {
        if (merged) {
          return { stdout: "0 0\n", stderr: "", code: 0 };
        }
        return {
          stdout: `${phase === "after-remediation" ? "0 1" : "1 1"}\n`,
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "rebase" && args[1] === "--abort") {
        timeline.push("rebase-abort");
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rebase") {
        timeline.push("rebase-failed");
        throw new Error("CONFLICT (content): Merge conflict in src/orchestrator.ts");
      }
      if (command === "git" && args[0] === "log") {
        return { stdout: "abc123 feat: review after rebase remediation\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "diff") {
        return { stdout: "diff --git a/orchestrator.ts b/orchestrator.ts\n", stderr: "", code: 0 };
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
      if (command === "bash" && args[1]?.includes("review-model")) {
        timeline.push("review");
        return {
          stdout: JSON.stringify({
            verdict: "approve",
            summary: "Rebased remediation result is safe to land.",
            feedback: [],
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "merge") {
        timeline.push("merge");
        merged = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const tmuxBackend = {
      ensureSession: vi.fn().mockResolvedValue({ sessionName: "pi-bw", created: false }),
      launchWorker: vi.fn().mockResolvedValue({
        sessionName: "pi-bw",
        windowName: "bw-101-rebase-review-remediation",
        paneId: "%90",
        launchCommand: initialWorker.launchCommand,
      }),
      inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
      cleanupWorker: vi.fn().mockResolvedValue(undefined),
    };

    const remediationStarted = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker: initialWorker,
      adapter,
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
          },
        },
      },
      tmuxBackend,
      runner,
    });

    expect(remediationStarted.status).toBe("running");
    expect(remediationStarted.reviewStatus).toBe("pending");
    expect(remediationStarted.reviewedWorkerHead).toBeUndefined();
    expect(timeline).toEqual(["rebase-failed", "rebase-abort"]);

    phase = "after-remediation";
    const landed = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker: {
        ...remediationStarted,
        status: "exited",
        ticketStatus: "closed",
        finishedAt: "2026-04-14T01:05:00.000Z",
      },
      adapter,
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
          },
        },
      },
      tmuxBackend,
      runner,
    });

    expect(landed.status).toBe("landed");
    expect(landed.reviewStatus).toBe("approved");
    expect(landed.reviewedWorkerHead).toBe("worker-remediated");
    expect(landed.landingRemediationAttempts).toBe(1);
    expect(timeline).toEqual(["rebase-failed", "rebase-abort", "review", "merge"]);
    expect(timeline.indexOf("review")).toBeLessThan(timeline.indexOf("merge"));
    expect(tmuxBackend.launchWorker).toHaveBeenCalledTimes(1);
  });

  it("reuses an approved review when a landing retry only needs final merge-back", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-review-reuse-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      validationStatus: "passed",
      status: "attention",
      reviewStatus: "approved",
      reviewVerdict: "approve",
      reviewSummary: "Reviewer approved merge-back. Looks good.",
      reviewedWorkerHead: "worker-head",
      landingVerification: "Fast-forward landing failed: repo advanced during merge.",
      lastError: "Fast-forward landing failed: repo advanced during merge.",
    });
    await saveWorkerRegistry(registryPath, [worker]);

    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(
        createIssue({
          id: "BW-101",
          type: "task",
          status: "closed",
          title: "Task",
          description: "Retry merge-back without rerunning review.",
          children: [],
        }),
      ),
    });

    let merged = false;
    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: `${merged ? "worker-head" : "repo-head"}\n`, stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { stdout: `${merged ? "0 0" : "0 1"}\n`, stderr: "", code: 0 };
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
      if (command === "bash" && args[1]?.includes("review-model")) {
        throw new Error("review should not rerun");
      }
      if (command === "git" && args[0] === "merge") {
        merged = true;
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

    const queued = await requestWorkerLanding({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
          },
        },
      },
      adapter,
      ticketId: "BW-101",
      tmuxBackend,
      runner,
    });

    expect(queued.reviewStatus).toBe("approved");
    expect(queued.reviewSummary).toContain("Reviewer approved merge-back");

    let finalRegistry = "";
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      finalRegistry = await readFile(registryPath, "utf8");
      if (finalRegistry.includes('"status": "landed"')) {
        break;
      }
    }

    expect(finalRegistry).toContain('"status": "landed"');
  });

  it("lands successfully when validation leaves behind transient context.md files", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-context-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    const contextPath = path.join(worktreePath, "context.md");
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      validationStatus: "pending",
      status: "exited",
    });

    const adapter = createAdapter({
      show: vi
        .fn()
        .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
    });

    let merged = false;
    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return {
          stdout: existsSync(contextPath) ? "?? context.md\n" : "",
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: `${merged ? "worker-head" : "repo-head"}\n`, stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { stdout: `${merged ? "0 0" : "0 1"}\n`, stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run lint") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run test") {
        await writeFile(contextPath, "generated context\n", "utf8");
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1] === "npm run typecheck") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "merge") {
        merged = true;
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

    const landed = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: DEFAULT_CONFIG,
      tmuxBackend,
      runner,
    });

    expect(landed.status).toBe("landed");
    expect(landed.validationStatus).toBe("passed");
    expect(existsSync(contextPath)).toBe(false);

    const workerLog = await readFile(worker.logFile, "utf8");
    expect(workerLog).toContain("cleaned transient worktree files after validation: context.md");
  });

  it("queues explicit landing retries without blocking on reviewer completion", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-queued-land-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      status: "attention",
      reviewStatus: "review-blocked",
      reviewSummary: "Previous reviewer run timed out.",
      lastError: "Previous reviewer run timed out.",
    });
    await saveWorkerRegistry(registryPath, [worker]);

    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(
        createIssue({
          id: "BW-101",
          type: "task",
          status: "closed",
          title: "Task",
          description: "Retry the reviewer gate in the background.",
          children: [],
        }),
      ),
    });

    let merged = false;
    let allowReviewToFinish!: () => void;
    const reviewCanFinish = new Promise<void>((resolve) => {
      allowReviewToFinish = resolve;
    });

    const runner = vi.fn(
      async (
        command: string,
        args: string[],
        options?: {
          cwd?: string;
          onStdoutChunk?: (chunk: string) => void;
          onStderrChunk?: (chunk: string) => void;
        },
      ) => {
        if (command === "git" && args[0] === "status") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
          return { stdout: `${merged ? "worker-head" : "repo-head"}\n`, stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
          return { stdout: "worker-head\n", stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "rev-list") {
          return { stdout: `${merged ? "0 0" : "0 2"}\n`, stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "log") {
          return { stdout: "abc123 feat: reviewer gate\n", stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return {
            stdout: "diff --git a/orchestrator.ts b/orchestrator.ts\n",
            stderr: "",
            code: 0,
          };
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
        if (command === "bash" && args[1]?.includes("review-model")) {
          options?.onStdoutChunk?.('{"verdict":"approve"');
          await reviewCanFinish;
          options?.onStdoutChunk?.(',"summary":"Looks good.","feedback":[]}');
          return {
            stdout: JSON.stringify({ verdict: "approve", summary: "Looks good.", feedback: [] }),
            stderr: "",
            code: 0,
          };
        }
        if (command === "git" && args[0] === "merge") {
          merged = true;
          return { stdout: "", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    );

    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
      cleanupWorker: vi.fn().mockResolvedValue(undefined),
    };

    const queued = await requestWorkerLanding({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
          },
        },
      },
      adapter,
      ticketId: "BW-101",
      tmuxBackend,
      runner,
    });

    expect(queued.status).toBe("exited");
    expect(queued.landingRequestedAt).toBeTruthy();
    expect(queued.validationStatus).toBe("pending");
    expect(queued.reviewStatus).toBe("pending");
    expect(queued.reviewSummary).toContain("review.log");

    const queuedRegistry = await readFile(registryPath, "utf8");
    expect(queuedRegistry).toContain("landingRequestedAt");

    allowReviewToFinish();

    let finalRegistry = "";
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      finalRegistry = await readFile(registryPath, "utf8");
      if (finalRegistry.includes('"status": "landed"')) {
        break;
      }
    }
    expect(finalRegistry).toContain('"status": "landed"');

    const reviewLog = await readFile(path.join(runtimeDir, "review.log"), "utf8");
    expect(reviewLog).toContain("[beadwork reviewer]");
  });

  it("waits for reviewer approval before merge-back cleanup when cleanup-after-landing is enabled", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-review-cleanup-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeRoot = path.join(repoRoot, ".pi", "beadwork", "workers", "runtime");
    const runtimeDir = path.join(runtimeRoot, "bw-101-worker");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "worker.log"), "worker output\n", "utf8");

    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      launchCommand: `bash ${path.join(runtimeDir, "launch.sh")}`,
      ticketStatus: "closed",
      status: "attention",
      cleanupPolicy: "cleanup-after-landing",
      cleanupStatus: "pending",
      reviewStatus: "review-blocked",
      reviewSummary: "Previous reviewer run timed out.",
      lastError: "Previous reviewer run timed out.",
    });
    await saveWorkerRegistry(registryPath, [worker]);

    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(
        createIssue({
          id: "BW-101",
          type: "task",
          status: "closed",
          title: "Task",
          description: "Require reviewer approval before merge-back cleanup.",
          children: [],
        }),
      ),
    });

    let merged = false;
    let allowReviewToFinish!: () => void;
    const reviewCanFinish = new Promise<void>((resolve) => {
      allowReviewToFinish = resolve;
    });
    const timeline: string[] = [];

    const runner = vi.fn(
      async (
        command: string,
        args: string[],
        options?: {
          cwd?: string;
          onStdoutChunk?: (chunk: string) => void;
          onStderrChunk?: (chunk: string) => void;
        },
      ) => {
        if (command === "git" && args[0] === "status") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
          return { stdout: `${merged ? "worker-head" : "repo-head"}\n`, stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
          return { stdout: "worker-head\n", stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "rev-list") {
          return { stdout: `${merged ? "0 0" : "0 2"}\n`, stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "log") {
          return { stdout: "abc123 feat: reviewer gate\n", stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "diff") {
          return {
            stdout: "diff --git a/orchestrator.ts b/orchestrator.ts\n",
            stderr: "",
            code: 0,
          };
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
        if (command === "bash" && args[1]?.includes("review-model")) {
          timeline.push("review-start");
          options?.onStdoutChunk?.('{"verdict":"approve"');
          await reviewCanFinish;
          timeline.push("review-finish");
          options?.onStdoutChunk?.(',"summary":"Looks good.","feedback":[]}');
          return {
            stdout: JSON.stringify({ verdict: "approve", summary: "Looks good.", feedback: [] }),
            stderr: "",
            code: 0,
          };
        }
        if (command === "git" && args[0] === "merge") {
          timeline.push("merge");
          merged = true;
          return { stdout: "", stderr: "", code: 0 };
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
          timeline.push("worktree-remove");
          return { stdout: "", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    );

    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
      cleanupWorker: vi.fn().mockImplementation(async () => {
        timeline.push("cleanup-worker");
      }),
    };

    const queued = await requestWorkerLanding({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: {
            ...DEFAULT_CONFIG.landing.review,
            enabled: true,
            model: "review-model",
          },
        },
        worktrees: {
          ...DEFAULT_CONFIG.worktrees,
          cleanup: "cleanup-after-landing",
        },
      },
      adapter,
      ticketId: "BW-101",
      tmuxBackend,
      runner,
    });

    expect(queued.status).toBe("exited");
    expect(queued.landingRequestedAt).toBeTruthy();
    expect(queued.reviewStatus).toBe("pending");
    expect(queued.cleanupStatus).toBe("pending");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (timeline.includes("review-start")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(timeline).toContain("review-start");
    expect(timeline).not.toContain("merge");
    expect(timeline).not.toContain("cleanup-worker");
    expect(timeline).not.toContain("worktree-remove");

    const pendingRegistry = await readFile(registryPath, "utf8");
    expect(pendingRegistry).not.toContain('"status": "landed"');
    expect(pendingRegistry).not.toContain('"cleanupStatus": "cleaned"');

    allowReviewToFinish();

    let finalRegistry = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      finalRegistry = await readFile(registryPath, "utf8");
      if (
        finalRegistry.includes('"status": "landed"') &&
        finalRegistry.includes('"cleanupStatus": "cleaned"')
      ) {
        break;
      }
    }

    expect(finalRegistry).toContain('"status": "landed"');
    expect(finalRegistry).toContain('"cleanupStatus": "cleaned"');
    expect(existsSync(runtimeDir)).toBe(false);
    expect(tmuxBackend.cleanupWorker).toHaveBeenCalledTimes(1);
    expect(timeline.indexOf("review-start")).toBeLessThan(timeline.indexOf("review-finish"));
    expect(timeline.indexOf("review-finish")).toBeLessThan(timeline.indexOf("merge"));
    expect(timeline.indexOf("merge")).toBeLessThan(timeline.indexOf("cleanup-worker"));
    expect(timeline.indexOf("cleanup-worker")).toBeLessThan(timeline.indexOf("worktree-remove"));
  });

  it("lands a previously held worker when explicitly requested", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-held-land-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      ticketStatus: "closed",
      status: "held",
      validationStatus: "passed",
      landingPolicy: "deferred",
      landingHeldAt: "2026-04-14T00:55:00.000Z",
      landingAheadCount: 2,
      landingBehindCount: 0,
      landingVerification:
        "Validated and held. Ready to land on explicit request (ahead=2, behind=0).",
    });

    const adapter = createAdapter({
      show: vi
        .fn()
        .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
    });

    let merged = false;
    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: `${merged ? "worker-head" : "repo-head"}\n`, stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { stdout: `${merged ? "0 0" : "0 2"}\n`, stderr: "", code: 0 };
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
        merged = true;
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
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          policy: "deferred",
        },
      },
      tmuxBackend,
      runner,
      requestLanding: true,
    });

    expect(inspected.status).toBe("landed");
    expect(inspected.validationStatus).toBe("passed");
    expect(inspected.landingVerifiedAt).toBeTruthy();
    expect(runner).toHaveBeenCalledWith(
      "git",
      ["merge", "--ff-only", "worker-head"],
      expect.objectContaining({ cwd: repoRoot }),
    );
  });

  it("keeps held workers unmerged and marks them for refresh when repo drift appears", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-held-refresh-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      ticketStatus: "closed",
      status: "held",
      validationStatus: "passed",
      landingPolicy: "deferred",
      landingHeldAt: "2026-04-14T00:55:00.000Z",
      landingAheadCount: 2,
      landingBehindCount: 0,
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
        return { stdout: "1 2\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "merge") {
        throw new Error("held refresh should not merge");
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
      config: {
        ...DEFAULT_CONFIG,
        landing: {
          ...DEFAULT_CONFIG.landing,
          policy: "deferred",
        },
      },
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("held");
    expect(inspected.landingVerification).toContain("needs refresh");
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

  it("emits a post-exit lifecycle event and appends orchestration progress to worker.log", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-land-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = path.join(repoRoot, "runtime");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });

    const logFile = path.join(runtimeDir, "worker.log");
    await writeFile(logFile, "", "utf8");

    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile,
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
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
    const onLifecycleEvent = vi.fn();

    await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: DEFAULT_CONFIG,
      tmuxBackend,
      runner,
      onLifecycleEvent,
    });

    expect(onLifecycleEvent).toHaveBeenCalledWith({
      type: "post-exit-started",
      ticketId: "BW-101",
      message: "Delegated ticket BW-101 exited. Starting validation and merge-back checks.",
    });

    const log = await readFile(logFile, "utf8");
    expect(log).toContain("starting post-worker validation and landing checks");
    expect(log).toContain("running configured validation commands before landing");
  });

  it("launches an automatic remediation pass when validation fails", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-land-worker-"));
    const worktreePath = path.join(repoRoot, "worktree");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-runtime-"));
    await mkdir(worktreePath, { recursive: true });

    const worker = createWorker({
      worktreePath,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
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
      ensureSession: vi.fn().mockResolvedValue({ sessionName: "pi-bw", created: false }),
      launchWorker: vi.fn().mockResolvedValue({
        sessionName: "pi-bw",
        windowName: "bw-101-remediation",
        paneId: "%77",
        launchCommand: worker.launchCommand,
      }),
      inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
      cleanupWorker: vi.fn().mockResolvedValue(undefined),
    };
    const onLifecycleEvent = vi.fn();

    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: DEFAULT_CONFIG,
      tmuxBackend,
      runner,
      onLifecycleEvent,
    });

    expect(inspected.status).toBe("running");
    expect(inspected.validationStatus).toBe("pending");
    expect(inspected.remediationStatus).toBe("running");
    expect(inspected.remediationAttempts).toBe(1);
    expect(inspected.tmuxPane).toBe("%77");
    expect(tmuxBackend.launchWorker).toHaveBeenCalled();
    expect(onLifecycleEvent).toHaveBeenCalledWith({
      type: "remediation-started",
      ticketId: "BW-101",
      message:
        "Validation failed for delegated ticket BW-101. Launching remediation attempt 1/1 in the existing worktree.",
    });
  });

  it("does not blindly rerun failed validation after remediation is exhausted", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-land-worker-"));

    const worker = createWorker({
      worktreePath: path.join(repoRoot, "worktree"),
      ticketStatus: "closed",
      status: "attention",
      validationStatus: "failed",
      validationSummary: "Validation failed on `npm run lint`: lint failed",
      remediationStatus: "exhausted",
      remediationAttempts: 1,
      remediationSummary:
        "Automatic remediation was attempted 1 time(s) and did not produce a passing validation result.",
    });

    const adapter = createAdapter({
      show: vi
        .fn()
        .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
    });

    const runner = vi.fn(async () => {
      throw new Error("validation should not rerun");
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
    expect(inspected.remediationStatus).toBe("exhausted");
    expect(runner).not.toHaveBeenCalled();
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

  it("records launch mode and path in run summary notes", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-launch-note-"));
    const ticket = createIssue({ id: "BW-201", type: "task", title: "Implement task" });
    const adapter = createAdapter({
      show: vi.fn(async (id: string) =>
        id === "BW-100"
          ? createIssue({ children: [ticket] })
          : createIssue({ id: ticket.id, type: "task", title: ticket.title }),
      ),
      ready: vi.fn().mockResolvedValue([ticket]),
    });
    const tmuxBackend = createMockTmuxBackend();
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return ok("main\n");
      }
      if (command === "git" && args.join(" ") === "rev-parse HEAD") {
        return ok("head123\n");
      }
      throw new Error(`unexpected process call: ${command} ${args.join(" ")}`);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        workerExecution: { ...DEFAULT_CONFIG.workerExecution, mode: "current-branch" },
      },
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
      tmuxBackend,
      runner,
    });

    expect(summary.notes).toContain(
      `Cycle 1: launched current-branch worker for BW-201 at checkoutPath ${repoRoot}.`,
    );
  });

  itInTmuxSession("stops for attention when ready work was already attempted", async () => {
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

  itInTmuxSession("does not stop for attention when ready work was already verified", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-verified-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      createWorker({
        executionMode: "current-branch",
        checkoutPath: repoRoot,
        branchName: "main",
        status: "verified",
        ticketStatus: "closed",
        validationStatus: "passed",
        landingVerifiedAt: "2026-04-14T00:10:00.000Z",
        landingVerification: "Current branch verified.",
        launchHead: "abc123",
      } as Partial<WorkerRuntime>),
    ]);

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

    expect(summary.stopReason).toBe("blocked");
    expect(summary.workerSummary.verified).toBe(1);
    expect(summary.workerSummary.successfulTerminal).toBe(1);
    expect(summary.cycleSummaries[0]?.verified).toEqual(["BW-101"]);
  });
});
