import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
  verifyCurrentBranchWorker,
} from "../../orchestrator.js";
import { defaultProcessRunner, ProcessCommandError } from "../../process.js";
import {
  loadWorkerRegistry,
  resolveWorkerRegistryPath,
  saveWorkerRegistry,
} from "../../registry.js";
import { createTmuxBackend, type TmuxBackend } from "../../tmux.js";
import type { BeadworkIssue, BeadworkIssueDetail, WorkerRuntime } from "../../types.js";

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

function stripChildren(issue: BeadworkIssueDetail): BeadworkIssue {
  const { children: _children, ...rest } = issue;
  return rest;
}

function createAdapter(overrides: Partial<BeadworkAdapter>): BeadworkAdapter {
  return {
    prime: vi.fn(),
    ready: vi.fn(),
    blocked: vi.fn(),
    list: vi.fn(),
    show: vi.fn(),
    history: vi.fn(async () => []),
    updateIssue: vi.fn(),
    comment: vi.fn(),
    label: vi.fn(),
    removeDependency: vi.fn(),
    reopen: vi.fn(),
    defer: vi.fn(),
    undefer: vi.fn(),
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

function createCurrentBranchWorker(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  const worker = createWorker({
    executionMode: "current-branch",
    checkoutPath: "/tmp/repo",
    branchName: "main",
    launchHead: "launch-head",
    ...overrides,
  });
  delete (worker as WorkerRuntime & { worktreePath?: string }).worktreePath;
  return worker;
}

async function createCurrentBranchRuntimeWorker(
  repoRoot: string,
  overrides: Partial<WorkerRuntime> = {},
): Promise<WorkerRuntime> {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-worker-"));
  await mkdir(runtimeDir, { recursive: true });
  const worker = createCurrentBranchWorker({
    checkoutPath: repoRoot,
    runtimeDir,
    promptFile: path.join(runtimeDir, "handoff.txt"),
    scriptFile: path.join(runtimeDir, "launch.sh"),
    logFile: path.join(runtimeDir, "worker.log"),
    stateFile: path.join(runtimeDir, "state.txt"),
    exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
    finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
    launchCommand: `bash ${path.join(runtimeDir, "launch.sh")}`,
    ...overrides,
  });
  await Promise.all([
    writeFile(worker.promptFile, "prompt\n", "utf8"),
    writeFile(worker.scriptFile, "#!/bin/sh\n", "utf8"),
    writeFile(worker.logFile, "log\n", "utf8"),
    writeFile(worker.stateFile, "exited\n", "utf8"),
    writeFile(worker.exitCodeFile, "0\n", "utf8"),
    writeFile(worker.finishedAtFile, "2026-04-14T00:00:02.000Z\n", "utf8"),
  ]);
  return worker;
}

function createGitRunner(commits: Array<{ sha: string; subject: string; paths: string[] }> = []) {
  return vi.fn(async (command: string, args: string[]) => {
    if (command !== "git") {
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    }
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
      return { stdout: "main\n", stderr: "", code: 0 };
    }
    if (args[0] === "rev-parse") {
      return { stdout: "worker-head\n", stderr: "", code: 0 };
    }
    if (args[0] === "merge-base") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "status") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "diff") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "log") {
      return {
        stdout: commits.map((commit) => `${commit.sha}\t${commit.subject}`).join("\n"),
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "show" && args.includes("--name-only")) {
      const sha = args[args.length - 1];
      const commit = commits.find((item) => item.sha === sha);
      return { stdout: `${commit?.paths.join("\n") ?? ""}\n`, stderr: "", code: 0 };
    }
    if (args[0] === "show") {
      const sha = args[args.length - 1];
      const commit = commits.find((item) => item.sha === sha);
      return { stdout: `${commit?.subject ?? "subject"}\n`, stderr: "", code: 0 };
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  });
}

function currentBranchVerificationConfig(reviewEnabled = false) {
  return {
    ...DEFAULT_CONFIG,
    workerExecution: {
      ...DEFAULT_CONFIG.workerExecution,
      mode: "current-branch" as const,
      review: { enabled: reviewEnabled },
    },
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
  it("routes closed current-branch exited workers to verification without worktree landing", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-verify-"));
    const runtimeDir = path.join(
      repoRoot,
      ".pi",
      "beadwork",
      "workers",
      "runtime",
      "bw-101-worker",
    );
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "worker.log"), "worker output\n", "utf8");

    const worker = createCurrentBranchWorker({
      checkoutPath: repoRoot,
      runtimeDir,
      promptFile: path.join(runtimeDir, "handoff.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "closed",
      status: "exited",
    });
    const adapter = createAdapter({
      show: vi
        .fn()
        .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
      history: vi.fn().mockResolvedValue([]),
    });
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "main\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse") {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "merge-base") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "log") {
        return { stdout: "abc123\tBW-101 implement task\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "show") {
        return { stdout: "src/task.ts\n", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1]?.includes("current-branch-review-handoff")) {
        return {
          stdout:
            '<review_report>{"summary":"Looks good.","findings":[{"file":"src/task.ts","issue":"missing edge case","suggestion":"cover the edge case","severity":"fix"},{"file":"src/task.test.ts","issue":"test name is vague","suggestion":"make the test name more specific","severity":"nit"}]}</review_report>',
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });
    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn().mockResolvedValue({
        sessionName: "pi-bw",
        windowName: "bw-101-window",
        paneId: "%43",
        launchCommand: "bash launch.sh",
      }),
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

    expect(inspected.status).toBe("running");
    expect(inspected.reviewStatus).toBe("remediation-in-progress");
    expect(inspected.reviewSummary).toContain("coordinator-approved fix");
    expect(inspected.reviewRawOutput).toContain("Looks good");
    expect(inspected.reviewFindings).toEqual([
      {
        file: "src/task.ts",
        issue: "missing edge case",
        suggestion: "cover the edge case",
        severity: "fix",
      },
      {
        file: "src/task.test.ts",
        issue: "test name is vague",
        suggestion: "make the test name more specific",
        severity: "nit",
      },
    ]);
    expect(inspected.reviewTriageDecisions?.map((decision) => decision.classification)).toEqual([
      "fix",
      "file",
    ]);
    const prompt = await readFile(
      path.join(runtimeDir, "current-branch-review-handoff.txt"),
      "utf8",
    );
    expect(prompt).toContain("ticket-attributed commits on the current branch");
    expect(prompt).toContain("BW-101");
    expect(prompt).toContain("abc123");
    expect(prompt).toContain("git show");
    expect(prompt).not.toContain("Unified diff excerpt");
    expect(prompt).not.toContain("launch-head..HEAD");
    expect(inspected.lastError).toBeUndefined();
    expect(inspected.landingVerification).toContain("remediation attempt 1/2");
    expect(runner).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining(["-lc", expect.stringContaining("current-branch-review-handoff")]),
      expect.objectContaining({
        cwd: repoRoot,
        timeout: DEFAULT_CONFIG.landing.review.commandTimeoutMs,
      }),
    );
    expect(tmuxBackend.cleanupWorker).toHaveBeenCalled();
    expect(adapter.reopen).toHaveBeenCalledWith(repoRoot, "BW-101");
    expect(adapter.comment).toHaveBeenCalledWith(
      repoRoot,
      "BW-101",
      expect.stringContaining("reopening this closed ticket"),
    );
    const remediationPrompt = await readFile(worker.promptFile, "utf8");
    expect(remediationPrompt).toContain("Continue ticket `BW-101` after coordinator review");
    expect(remediationPrompt).toContain("missing edge case");
    expect(remediationPrompt).not.toContain("test name is vague");
    await expect(readFile(worker.logFile, "utf8")).resolves.toContain(
      "starting current-branch verification",
    );
  });

  it("replaces crashed current-branch workers with inherited launch context and no duplicate relaunch", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-crash-replace-"));
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      status: "running",
      launchHead: "launch-base",
      workerId: "bw-101-original",
      tmuxPane: "%99",
    });
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [worker]);

    const ticket = createIssue({
      id: "BW-101",
      type: "task",
      title: "Crash task",
      status: "open",
      parentId: "BW-100",
    });
    const adapter = createLaunchAdapter(ticket, createIssue({ id: "BW-100", type: "epic" }));
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "log") {
        expect(args).toEqual(["log", "--oneline", "launch-base..HEAD", "--grep=BW-101"]);
        return { stdout: "abc123 BW-101 partial commit\n", stderr: "", code: 0 };
      }
      if (command === "bash" && args[0] === "-lc") {
        return {
          stdout: JSON.stringify({ classification: "replace", rationale: "no handoff found" }),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });
    const tmuxBackend = createMockTmuxBackend();
    tmuxBackend.inspectWorker = vi.fn().mockResolvedValue({ exists: false });

    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: DEFAULT_CONFIG,
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("failed");
    expect(inspected.currentBranchCrashReason).toContain("state is exited");
    expect(inspected.supersededByWorkerId).toBeTruthy();
    expect(tmuxBackend.launchWorker).toHaveBeenCalledTimes(1);
    const workersAfterFirstPoll = await loadWorkerRegistry(registryPath);
    const replacement = workersAfterFirstPoll.find(
      (candidate) => candidate.replacesWorkerId === worker.workerId,
    );
    expect(replacement).toMatchObject({
      status: "running",
      executionMode: "current-branch",
      checkoutPath: repoRoot,
      launchHead: "launch-base",
      currentBranchCrashReplacementAttempt: 1,
    });
    expect(replacement?.workerId).toBe(inspected.supersededByWorkerId);
    const prompt = await readFile(replacement?.promptFile ?? "", "utf8");
    expect(prompt).toContain("Current-branch crash recovery replacement");
    expect(prompt).toContain("abc123 BW-101 partial commit");
    expect(prompt).toContain("Dead worker state file: exited");
    expect(prompt).toContain("Original launch head (preserved for attribution): launch-base");
    expect(prompt).toContain("First verify the existing commits");
    expect(prompt).toContain("Do not reset, stash, revert, or amend");
    expect(runner.mock.calls.flatMap((call) => call[1]).join(" ")).not.toMatch(
      /\b(reset|stash|revert|amend)\b/,
    );

    const inspectedAgain = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: DEFAULT_CONFIG,
      tmuxBackend,
      runner,
    });

    expect(inspectedAgain.supersededByWorkerId).toBe(replacement?.workerId);
    expect(tmuxBackend.launchWorker).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls.filter((call) => call[0] === "bash")).toHaveLength(1);
  });

  it("routes crashed current-branch workers with actionable blocker handoffs to attention", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-crash-blocked-"));
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      status: "running",
      workerId: "bw-101-blocked",
    });
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [worker]);
    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "open" })),
      history: vi
        .fn()
        .mockResolvedValue([
          { type: "comment", text: "Handoff: blocked waiting for production credentials." },
        ]),
    });
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "log") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[0] === "-lc") {
        return {
          stdout: JSON.stringify({
            classification: "attention",
            rationale: "worker left an actionable blocker",
            actionableBlocker: "waiting for production credentials",
          }),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });
    const tmuxBackend = createMockTmuxBackend();
    tmuxBackend.inspectWorker = vi.fn().mockResolvedValue({ exists: false });

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
    expect(inspected.lastError).toContain("waiting for production credentials");
    expect(inspected.currentBranchCrashJudgment).toContain("attention");
    expect(tmuxBackend.launchWorker).not.toHaveBeenCalled();
    expect(await loadWorkerRegistry(registryPath)).toHaveLength(1);
  });

  it("treats maxLifetime expiry as a bounded current-branch crash trigger", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-crash-timeout-"));
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      status: "running",
      workerId: "bw-101-timeout",
      startedAt: "1970-01-01T00:00:00.000Z",
    });
    await writeFile(worker.stateFile, "running\n", "utf8");
    await writeFile(worker.exitCodeFile, "", "utf8");
    await writeFile(worker.finishedAtFile, "", "utf8");
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [worker]);
    const adapter = createLaunchAdapter(
      createIssue({ id: "BW-101", type: "task", status: "open", parentId: "BW-100" }),
      createIssue({ id: "BW-100", type: "epic" }),
    );
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "log") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[0] === "-lc") {
        return {
          stdout: JSON.stringify({ classification: "replace", rationale: "timed out" }),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });
    const tmuxBackend = createMockTmuxBackend();
    tmuxBackend.inspectWorker = vi.fn().mockResolvedValue({
      exists: true,
      sessionName: "pi-bw",
      windowName: "bw-101",
      paneId: "%99",
    });

    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: {
        ...DEFAULT_CONFIG,
        workerExecution: { ...DEFAULT_CONFIG.workerExecution, maxLifetime: 1 },
      },
      tmuxBackend,
      runner,
    });

    expect(inspected.currentBranchCrashReason).toContain("maxLifetime");
    expect(inspected.status).toBe("failed");
    expect(tmuxBackend.cleanupWorker).toHaveBeenCalledWith({
      paneId: "%99",
      sessionName: "pi-bw",
      windowName: "bw-101",
    });
    expect(tmuxBackend.launchWorker).toHaveBeenCalledTimes(1);
  });

  it("stops replacing current-branch workers after the crash cap", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-crash-cap-"));
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      status: "running",
      workerId: "bw-101-third-crash",
    });
    const priorOne = createCurrentBranchWorker({
      ...worker,
      workerId: "bw-101-first-crash",
      currentBranchCrashReason: "first crash",
      status: "failed",
    });
    const priorTwo = createCurrentBranchWorker({
      ...worker,
      workerId: "bw-101-second-crash",
      currentBranchCrashReason: "second crash",
      status: "failed",
    });
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [priorOne, priorTwo, worker]);
    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "open" })),
      history: vi.fn().mockResolvedValue([]),
    });
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "log") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[0] === "-lc") {
        return {
          stdout: JSON.stringify({ classification: "replace", rationale: "third crash" }),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });
    const tmuxBackend = createMockTmuxBackend();
    tmuxBackend.inspectWorker = vi.fn().mockResolvedValue({ exists: false });

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
    expect(inspected.lastError).toContain("crash cap reached");
    expect(inspected.currentBranchCrashReplacementAttempt).toBe(3);
    expect(tmuxBackend.launchWorker).not.toHaveBeenCalled();
  });

  it("does not duplicate remediation relaunches while an active finding set is still running", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-no-duplicate-"));
    const finding = {
      file: "src/task.ts",
      issue: "broken behavior",
      suggestion: "fix it",
      severity: "fix" as const,
    };
    const findingSetKey = [finding.severity, finding.file, finding.issue, finding.suggestion]
      .map((value) => value.trim().toLowerCase())
      .join("|");
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      ticketStatus: "open",
      status: "running",
      reviewStatus: "remediation-in-progress",
      reviewRemediationAttempts: 1,
      reviewFindings: [finding],
      reviewTriageFindingSetKey: findingSetKey,
      currentBranchRemediationFindingSetKey: findingSetKey,
      reviewTriageDecisions: [
        {
          finding,
          findingKey: findingSetKey,
          classification: "fix",
          rationale: "already approved",
          action: "approved for current-branch remediation",
        },
      ],
    });
    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn(),
      cleanupWorker: vi.fn(),
    };

    const inspected = await verifyCurrentBranchWorker({
      cwd: repoRoot,
      worker,
      config: currentBranchVerificationConfig(false),
      adapter: createAdapter({
        show: vi.fn().mockResolvedValue(createIssue({ id: "BW-101", status: "open" })),
        history: vi.fn().mockResolvedValue([]),
      }),
      tmuxBackend,
      runner: createGitRunner([
        { sha: "abc123", subject: "BW-101 implement", paths: ["src/task.ts"] },
      ]),
    });

    expect(inspected.status).toBe("running");
    expect(inspected.reviewStatus).toBe("remediation-in-progress");
    expect(inspected.reviewRemediationAttempts).toBe(1);
    expect(tmuxBackend.launchWorker).not.toHaveBeenCalled();
  });

  it("reruns review after current-branch remediation exits and closes the ticket", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-remediated-review-"));
    const finding = {
      file: "src/task.ts",
      issue: "broken behavior",
      suggestion: "fix it",
      severity: "fix" as const,
    };
    const findingSetKey = [finding.severity, finding.file, finding.issue, finding.suggestion]
      .map((value) => value.trim().toLowerCase())
      .join("|");
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      ticketStatus: "closed",
      status: "exited",
      reviewStatus: "remediation-in-progress",
      reviewRemediationAttempts: 1,
      reviewFindings: [finding],
      reviewTriageFindingSetKey: findingSetKey,
      currentBranchRemediationFindingSetKey: findingSetKey,
      reviewTriageDecisions: [
        {
          finding,
          findingKey: findingSetKey,
          classification: "fix",
          rationale: "approved before remediation",
          action: "approved for current-branch remediation",
        },
      ],
    });
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [worker]);
    const [persistedWorker] = await loadWorkerRegistry(registryPath);
    expect(persistedWorker).toMatchObject({
      status: "exited",
      ticketStatus: "closed",
      reviewStatus: "remediation-in-progress",
      reviewRemediationAttempts: 1,
    });

    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "main\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse") {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "merge-base") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "log") {
        return { stdout: "abc123\tBW-101 remediate review finding\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "show") {
        return { stdout: "src/task.ts\n", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1]?.includes("current-branch-review-handoff")) {
        return {
          stdout:
            '<review_report>{"summary":"Remediation looks good.","findings":[]}</review_report>',
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });
    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn(),
      cleanupWorker: vi.fn(),
    };

    const inspected = await verifyCurrentBranchWorker({
      cwd: repoRoot,
      repoRoot,
      worker: persistedWorker ?? worker,
      config: currentBranchVerificationConfig(true),
      adapter: createAdapter({
        show: vi.fn().mockResolvedValue(createIssue({ id: "BW-101", status: "closed" })),
        history: vi.fn().mockResolvedValue([]),
      }),
      tmuxBackend,
      runner,
    });

    expect(inspected.status).toBe("verified");
    expect(inspected.reviewStatus).toBe("approved");
    expect(inspected.reviewRemediationAttempts).toBe(1);
    expect(inspected.reviewTriageDecisions).toEqual([]);
    expect(inspected.landingVerification).toContain("Current-branch worker verified");
    expect(runner.mock.calls.filter((call) => call[0] === "bash")).toHaveLength(1);
    expect(tmuxBackend.launchWorker).not.toHaveBeenCalled();
  });

  it("allows a second current-branch remediation for the same unresolved finding set", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-second-remediation-"));
    const finding = {
      file: "src/task.ts",
      issue: "broken behavior",
      suggestion: "fix it",
      severity: "fix" as const,
    };
    const findingSetKey = [finding.severity, finding.file, finding.issue, finding.suggestion]
      .map((value) => value.trim().toLowerCase())
      .join("|");
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      ticketStatus: "closed",
      status: "exited",
      reviewStatus: "changes-requested",
      reviewRemediationAttempts: 1,
      reviewFindings: [finding],
      reviewTriageFindingSetKey: findingSetKey,
      currentBranchRemediationFindingSetKey: findingSetKey,
      reviewTriageDecisions: [
        {
          finding,
          findingKey: findingSetKey,
          classification: "fix",
          rationale: "still unresolved",
          action: "approved for current-branch remediation",
        },
      ],
    });
    const tmuxBackend = {
      ensureSession: vi.fn().mockResolvedValue({ sessionName: "pi-bw", created: false }),
      launchWorker: vi.fn().mockResolvedValue({
        sessionName: "pi-bw",
        windowName: "bw-101-second-window",
        paneId: "%44",
        launchCommand: "bash launch.sh",
      }),
      inspectWorker: vi.fn(),
      cleanupWorker: vi.fn(),
    };
    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) => {
        if (id === "BW-101") {
          return createIssue({ id: "BW-101", type: "task", status: "closed" });
        }
        if (id === "BW-100") {
          return createIssue({ id: "BW-100", type: "epic", status: "open" });
        }
        throw new Error(`unexpected issue ${id}`);
      }),
      history: vi.fn().mockResolvedValue([]),
      reopen: vi.fn(),
      comment: vi.fn(),
    });

    const inspected = await verifyCurrentBranchWorker({
      cwd: repoRoot,
      worker,
      config: currentBranchVerificationConfig(false),
      adapter,
      tmuxBackend,
      runner: createGitRunner([
        { sha: "abc123", subject: "BW-101 implement", paths: ["src/task.ts"] },
      ]),
    });

    expect(inspected.status).toBe("running");
    expect(inspected.reviewStatus).toBe("remediation-in-progress");
    expect(inspected.reviewRemediationAttempts).toBe(2);
    expect(inspected.landingVerification).toContain("remediation attempt 2/2");
    expect(tmuxBackend.launchWorker).toHaveBeenCalledTimes(1);
    expect(adapter.reopen).toHaveBeenCalledWith(repoRoot, "BW-101");
    await expect(readFile(worker.promptFile, "utf8")).resolves.toContain("broken behavior");
  });

  it("skips current-branch review only when workerExecution.review.enabled is false", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-skip-review-"));
    const runtimeDir = path.join(
      repoRoot,
      ".pi",
      "beadwork",
      "workers",
      "runtime",
      "bw-101-worker",
    );
    await mkdir(runtimeDir, { recursive: true });
    const worker = createWorker({
      status: "exited",
      ticketStatus: "closed",
      executionMode: "current-branch",
      checkoutPath: repoRoot,
      branchName: "main",
      launchHead: "launch-head",
      runtimeDir,
      logFile: path.join(runtimeDir, "worker.log"),
      promptFile: path.join(runtimeDir, "prompt.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
    });
    await writeFile(worker.logFile, "", "utf8");
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "main\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse") {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "merge-base") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "log") {
        return { stdout: "abc123\tBW-101 implement task\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "show") {
        return { stdout: "src/task.ts\n", stderr: "", code: 0 };
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });

    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter: createAdapter({
        show: vi
          .fn()
          .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
      }),
      config: {
        ...DEFAULT_CONFIG,
        workerExecution: { ...DEFAULT_CONFIG.workerExecution, review: { enabled: false } },
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: { ...DEFAULT_CONFIG.landing.review, enabled: true },
        },
      },
      tmuxBackend: {
        ensureSession: vi.fn(),
        launchWorker: vi.fn(),
        inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
        cleanupWorker: vi.fn().mockResolvedValue(undefined),
      },
      runner,
    });

    expect(inspected.reviewSummary).toContain("workerExecution.review.enabled=false");
    expect(runner.mock.calls.some((call) => call[0] === "bash")).toBe(false);
  });

  it("files non-blocking triage findings, rejects invalid findings, and verifies without fixes", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-triage-file-"));
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      ticketStatus: "closed",
      status: "exited",
      reviewStatus: "changes-requested",
      reviewFindings: [
        {
          file: "src/task.ts",
          issue: "style only follow-up: name could be clearer",
          suggestion: "consider renaming later",
          severity: "nit",
        },
        {
          file: "src/task.ts",
          issue: "false positive: reviewer misunderstood existing guard",
          suggestion: "no change needed",
          severity: "fix",
        },
      ],
      reviewRawOutput: "raw reviewer json",
    });
    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(createIssue({ id: "BW-101", status: "closed" })),
      history: vi.fn().mockResolvedValue([]),
      comment: vi.fn().mockResolvedValue(createIssue({ id: "BW-101", status: "closed" })),
    });
    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn(),
      cleanupWorker: vi.fn(),
    };

    const inspected = await verifyCurrentBranchWorker({
      cwd: repoRoot,
      worker,
      config: currentBranchVerificationConfig(false),
      adapter,
      tmuxBackend,
      runner: createGitRunner([
        { sha: "abc123", subject: "BW-101 implement", paths: ["src/task.ts"] },
      ]),
    });

    expect(inspected.status).toBe("verified");
    expect(inspected.commitShas).toEqual(["abc123"]);
    expect(inspected.touchedPaths).toEqual(["src/task.ts"]);
    expect(inspected.reviewRawOutput).toBe("raw reviewer json");
    expect(inspected.reviewTriageDecisions?.map((decision) => decision.classification)).toEqual([
      "file",
      "reject",
    ]);
    expect(adapter.comment).toHaveBeenCalledWith(
      repoRoot,
      "BW-101",
      expect.stringContaining("non-blocking follow-up"),
    );
    expect(tmuxBackend.launchWorker).not.toHaveBeenCalled();
  });

  it("enforces the two-attempt current-branch remediation cap", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-triage-cap-"));
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      ticketStatus: "closed",
      status: "exited",
      reviewStatus: "changes-requested",
      reviewRemediationAttempts: 2,
      reviewFindings: [
        {
          file: "src/task.ts",
          issue: "regression still broken",
          suggestion: "fix the regression",
          severity: "fix",
        },
      ],
    });
    const tmuxBackend = {
      ensureSession: vi.fn(),
      launchWorker: vi.fn(),
      inspectWorker: vi.fn(),
      cleanupWorker: vi.fn(),
    };

    const inspected = await verifyCurrentBranchWorker({
      cwd: repoRoot,
      worker,
      config: currentBranchVerificationConfig(false),
      adapter: createAdapter({
        show: vi.fn().mockResolvedValue(createIssue({ id: "BW-101", status: "closed" })),
        history: vi.fn().mockResolvedValue([]),
      }),
      tmuxBackend,
      runner: createGitRunner([
        { sha: "abc123", subject: "BW-101 implement", paths: ["src/task.ts"] },
      ]),
    });

    expect(inspected.status).toBe("attention");
    expect(inspected.lastError).toContain("attempts exhausted (2/2)");
    expect(tmuxBackend.launchWorker).not.toHaveBeenCalled();

    expect(inspected.reviewRemediationAttempts).toBe(2);
  });

  it("reruns current-branch review when cached approval is for a stale HEAD", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-stale-review-"));
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      ticketStatus: "closed",
      status: "exited",
      reviewStatus: "approved",
      reviewVerdict: "approve",
      reviewFindings: [],
      reviewedWorkerHead: "old-head",
    });
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "main\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse") {
        return { stdout: "new-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "merge-base") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "log") {
        return { stdout: "abc123\tBW-101 implement task\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "show") {
        return { stdout: "src/task.ts\n", stderr: "", code: 0 };
      }
      if (command === "bash" && args[1]?.includes("current-branch-review-handoff")) {
        return {
          stdout: '<review_report>{"summary":"Fresh approval.","findings":[]}</review_report>',
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });

    const inspected = await verifyCurrentBranchWorker({
      cwd: repoRoot,
      worker,
      config: currentBranchVerificationConfig(true),
      adapter: createAdapter({
        show: vi.fn().mockResolvedValue(createIssue({ id: "BW-101", status: "closed" })),
        history: vi.fn().mockResolvedValue([]),
      }),
      tmuxBackend: {
        ensureSession: vi.fn(),
        launchWorker: vi.fn(),
        inspectWorker: vi.fn(),
        cleanupWorker: vi.fn(),
      },
      runner,
    });

    expect(inspected.status).toBe("verified");
    expect(inspected.reviewStatus).toBe("approved");
    expect(inspected.reviewedWorkerHead).toBe("new-head");
    expect(runner.mock.calls.filter((call) => call[0] === "bash")).toHaveLength(1);
  });

  it("verifies closed no-code tickets only when beadwork history explains the no-commit outcome", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-no-code-"));
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      ticketStatus: "closed",
      status: "exited",
      reviewStatus: "approved",
      reviewFindings: [],
    });

    const inspected = await verifyCurrentBranchWorker({
      cwd: repoRoot,
      worker,
      config: currentBranchVerificationConfig(false),
      adapter: createAdapter({
        show: vi.fn().mockResolvedValue(createIssue({ id: "BW-101", status: "closed" })),
        history: vi.fn().mockResolvedValue([
          {
            intent: "comment",
            body: "No code changes needed because this was already complete.",
          },
        ]),
      }),
      tmuxBackend: {
        ensureSession: vi.fn(),
        launchWorker: vi.fn(),
        inspectWorker: vi.fn(),
        cleanupWorker: vi.fn(),
      },
      runner: createGitRunner([]),
    });

    expect(inspected.status).toBe("verified");
    expect(inspected.commitShas).toEqual([]);
    expect(inspected.validationSummary).toContain("no-code ticket");
  });

  it("routes unexplained no-commit current-branch workers to attention", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-no-attribution-"));
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      ticketStatus: "closed",
      status: "exited",
      reviewStatus: "approved",
      reviewFindings: [],
    });

    const inspected = await verifyCurrentBranchWorker({
      cwd: repoRoot,
      worker,
      config: currentBranchVerificationConfig(false),
      adapter: createAdapter({
        show: vi.fn().mockResolvedValue(createIssue({ id: "BW-101", status: "closed" })),
        history: vi.fn().mockResolvedValue([]),
      }),
      tmuxBackend: {
        ensureSession: vi.fn(),
        launchWorker: vi.fn(),
        inspectWorker: vi.fn(),
        cleanupWorker: vi.fn(),
      },
      runner: createGitRunner([]),
    });

    expect(inspected.status).toBe("attention");
    expect(inspected.lastError).toContain("no attributed commits");
  });

  it("routes unparseable current-branch reviewer output to attention with raw output", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-bad-review-"));
    const runtimeDir = path.join(
      repoRoot,
      ".pi",
      "beadwork",
      "workers",
      "runtime",
      "bw-101-worker",
    );
    await mkdir(runtimeDir, { recursive: true });
    const worker = createWorker({
      status: "exited",
      ticketStatus: "closed",
      executionMode: "current-branch",
      checkoutPath: repoRoot,
      branchName: "main",
      launchHead: "launch-head",
      runtimeDir,
      logFile: path.join(runtimeDir, "worker.log"),
      promptFile: path.join(runtimeDir, "prompt.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
    });
    await writeFile(worker.logFile, "", "utf8");
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "main\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse") {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "merge-base") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "log") {
        return { stdout: "abc123\tBW-101 implement task\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "show") {
        return { stdout: "src/task.ts\n", stderr: "", code: 0 };
      }
      if (command === "bash") {
        return { stdout: "not structured", stderr: "", code: 0 };
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    });

    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter: createAdapter({
        show: vi
          .fn()
          .mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "closed" })),
        history: vi.fn().mockResolvedValue([]),
      }),
      config: DEFAULT_CONFIG,
      tmuxBackend: {
        ensureSession: vi.fn(),
        launchWorker: vi.fn(),
        inspectWorker: vi.fn().mockResolvedValue({ exists: false }),
        cleanupWorker: vi.fn().mockResolvedValue(undefined),
      },
      runner,
    });

    expect(inspected.status).toBe("attention");
    expect(inspected.reviewStatus).toBe("review-blocked");
    expect(inspected.reviewRawOutput).toContain("not structured");
    expect(inspected.lastError).toContain("Current-branch reviewer gate failed");
  });

  it("routes open-ticket exited current-branch workers through crash recovery", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-open-"));
    const runtimeDir = path.join(
      repoRoot,
      ".pi",
      "beadwork",
      "workers",
      "runtime",
      "bw-101-worker",
    );
    await mkdir(runtimeDir, { recursive: true });

    const worker = createCurrentBranchWorker({
      checkoutPath: repoRoot,
      runtimeDir,
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      ticketStatus: "open",
      status: "exited",
    });
    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(createIssue({ id: "BW-101", type: "task", status: "open" })),
      history: vi
        .fn()
        .mockResolvedValue([{ type: "comment", text: "handoff: blocked by missing dependency" }]),
    });
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "log") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "bash" && args[0] === "-lc") {
        return {
          stdout: JSON.stringify({
            classification: "attention",
            rationale: "actionable blocker",
            actionableBlocker: "missing dependency",
          }),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
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
    expect(inspected.lastError).toContain("missing dependency");
    expect(inspected.landingVerification).toContain("Crash recovery routed to operator attention");
    expect(runner).toHaveBeenCalled();
    expect(tmuxBackend.launchWorker).not.toHaveBeenCalled();
    expect(tmuxBackend.cleanupWorker).not.toHaveBeenCalled();
  });

  it("returns immediately for already verified, attention, and failed current-branch workers", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-idempotent-"));
    const operation = vi.fn(async ({ worker }: { worker: WorkerRuntime }) => ({
      ...worker,
      status: "verified" as const,
    }));
    const adapter = createAdapter({});
    const runner = vi.fn(async () => ok());
    const tmuxBackend = createMockTmuxBackend();

    for (const status of ["verified", "attention", "failed"] as const) {
      const worker = createCurrentBranchWorker({ checkoutPath: repoRoot, status });
      const inspected = await verifyCurrentBranchWorker({
        cwd: repoRoot,
        repoRoot,
        worker,
        adapter,
        config: DEFAULT_CONFIG,
        runner,
        tmuxBackend,
        pipeline: { markVerified: operation },
      });
      expect(inspected.status).toBe(status);
    }

    expect(operation).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent current-branch verification for one worker", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-dedupe-"));
    const runtimeDir = path.join(
      repoRoot,
      ".pi",
      "beadwork",
      "workers",
      "runtime",
      "bw-101-worker",
    );
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "worker.log"), "worker output\n", "utf8");
    const worker = createCurrentBranchWorker({
      checkoutPath: repoRoot,
      runtimeDir,
      logFile: path.join(runtimeDir, "worker.log"),
      status: "exited",
      ticketStatus: "closed",
    });
    const adapter = createAdapter({});
    const runner = vi.fn(async () => ok());
    const tmuxBackend = createMockTmuxBackend();
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const markVerified = vi.fn(async ({ worker: currentWorker }: { worker: WorkerRuntime }) => {
      await verificationGate;
      return {
        ...currentWorker,
        status: "verified" as const,
        landingVerification: "current-branch verification complete",
        updatedAt: new Date().toISOString(),
      };
    });

    const first = verifyCurrentBranchWorker({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: DEFAULT_CONFIG,
      runner,
      tmuxBackend,
      pipeline: { markVerified },
    });
    const second = verifyCurrentBranchWorker({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter,
      config: DEFAULT_CONFIG,
      runner,
      tmuxBackend,
      pipeline: { markVerified },
    });

    releaseVerification();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe("verified");
    expect(secondResult.status).toBe("verified");
    expect(markVerified).toHaveBeenCalledTimes(1);
  });
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
    expect(runner).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["rebase"]),
      expect.objectContaining({ cwd: worktreePath }),
    );
    expect(runner).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["merge"]),
      expect.objectContaining({ cwd: repoRoot }),
    );
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
      expect.objectContaining({
        type: "remediation-started",
        ticketId: "BW-101",
        executionMode: "worktree",
        message: expect.stringContaining("BW-101 [worktree]"),
      }),
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
      expect.objectContaining({
        type: "remediation-started",
        ticketId: "BW-101",
        executionMode: "worktree",
        message: expect.stringContaining("BW-101 [worktree]"),
      }),
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
      executionMode: "worktree",
      message:
        "Delegated ticket BW-101 [worktree] exited. Starting validation and merge-back checks.",
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
      executionMode: "worktree",
      message:
        "Validation failed for delegated ticket BW-101 [worktree]. Launching remediation attempt 1/1 in the existing worktree.",
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

  it("does not complete a closed epic while a descendant child remains open", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-open-descendant-"));
    const openGrandchild = createIssue({ id: "BW-102", type: "task", title: "Open child" });
    const closedChildEpic = createIssue({
      id: "BW-101",
      type: "epic",
      title: "Closed child epic",
      status: "closed",
      children: [openGrandchild],
    });
    const rootEpic = createIssue({
      id: "BW-100",
      type: "epic",
      status: "closed",
      children: [stripChildren(closedChildEpic)],
    });
    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) => {
        if (id === "BW-100") {
          return rootEpic;
        }
        if (id === "BW-101") {
          return closedChildEpic;
        }
        return openGrandchild;
      }),
      ready: vi.fn().mockResolvedValue([]),
    });
    const runner = vi.fn(async () => ok("scope-ok\n"));

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
      },
      adapter,
      epicId: "BW-100",
      runner,
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
    expect(runner).not.toHaveBeenCalled();
  });

  it("does not complete a closed root while a child epic remains open", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-open-child-epic-"));
    const closedGrandchild = createIssue({
      id: "BW-102",
      type: "task",
      title: "Closed grandchild",
      status: "closed",
    });
    const openChildEpic = createIssue({
      id: "BW-101",
      type: "epic",
      title: "Open child epic",
      status: "open",
      children: [stripChildren(closedGrandchild)],
    });
    const rootEpic = createIssue({
      id: "BW-100",
      type: "epic",
      status: "closed",
      children: [stripChildren(openChildEpic)],
    });
    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) => {
        if (id === "BW-100") {
          return rootEpic;
        }
        if (id === "BW-101") {
          return openChildEpic;
        }
        return closedGrandchild;
      }),
      ready: vi.fn().mockResolvedValue([]),
    });
    const runner = vi.fn(async () => ok("scope-ok\n"));

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
      },
      adapter,
      epicId: "BW-100",
      runner,
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
    expect(runner).not.toHaveBeenCalled();
  });

  it("does not complete an open root even when every child is closed", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-open-root-"));
    const closedChild = createIssue({
      id: "BW-101",
      type: "task",
      title: "Closed child",
      status: "closed",
    });
    const rootEpic = createIssue({
      id: "BW-100",
      type: "epic",
      status: "open",
      children: [stripChildren(closedChild)],
    });
    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) => (id === "BW-100" ? rootEpic : closedChild)),
      ready: vi.fn().mockResolvedValue([]),
    });
    const runner = vi.fn(async () => ok("scope-ok\n"));

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
      },
      adapter,
      epicId: "BW-100",
      runner,
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
    expect(runner).not.toHaveBeenCalled();
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

  it("runs scope-completion review after validation passes at quiescence", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-inline-review-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      await createCurrentBranchRuntimeWorker(repoRoot, {
        status: "exited",
        ticketStatus: "closed",
        launchHead: "base-sha",
        commitShas: ["commit-sha"],
        touchedPaths: ["src/task.ts"],
      }),
    ]);

    const epic = createIssue({
      status: "closed",
      description: "Goal: complete the integrated scope.",
      children: [createIssue({ id: "BW-101", type: "task", title: "Task", status: "closed" })],
    });
    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) =>
        id === "BW-100" ? epic : createIssue({ id: "BW-101", type: "task", status: "closed" }),
      ),
      history: vi.fn(async () => []),
      list: vi.fn(async () => []),
      createIssue: vi.fn(),
      ready: vi.fn().mockResolvedValue([]),
    });
    const gitRunner = createGitRunner([
      { sha: "commit-sha", subject: "Implement task", paths: ["src/task.ts"] },
    ]);
    let reviewerPrompt = "";
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "bash" && args.join(" ") === "-lc echo scope-ok") {
        return ok("scope-ok\n");
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
        const promptFile = args[1].match(/\$\(cat ([^)]+)\)/)?.[1]?.replace(/^'|'$/g, "");
        reviewerPrompt = promptFile ? await readFile(promptFile, "utf8") : "";
        return ok(JSON.stringify({ summary: "scope complete", findings: [] }));
      }
      return gitRunner(command, args);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...currentBranchVerificationConfig(false),
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("completed");
    expect(summary.workerSummary.verified).toBe(1);
    expect(runner).toHaveBeenCalledWith("bash", ["-lc", "echo scope-ok"], expect.anything());
    expect(reviewerPrompt).toContain("Goal: complete the integrated scope.");
    expect(reviewerPrompt).toContain("BW-101");
    expect(reviewerPrompt).toContain("commit-sha");
    expect(reviewerPrompt).toContain("Implement task");
    expect(reviewerPrompt).toContain("scope-ok");
    expect(summary.notes.join("\n")).toContain("Scope review:");
    expect((await loadWorkerRegistry(registryPath))[0]).toMatchObject({ status: "verified" });
  });

  async function runScopeReviewScenario(options: {
    reviewer: unknown;
    existingIssues?: ReturnType<typeof createIssue>[];
    maxCycles?: number;
    ready?: BeadworkAdapter["ready"];
  }) {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-scope-review-case-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      await createCurrentBranchRuntimeWorker(repoRoot, {
        status: "exited",
        ticketStatus: "closed",
        launchHead: "base-sha",
        commitShas: ["commit-sha"],
        touchedPaths: ["src/task.ts"],
      }),
    ]);
    const existingIssues = options.existingIssues ?? [];
    const createIssueMock = vi.fn(
      async (_cwd: string, input: Parameters<BeadworkAdapter["createIssue"]>[1]) => ({
        issue: createIssue({
          id: `BW-FOLLOW-${createIssueMock.mock.calls.length}`,
          title: input.title,
          description: input.description ?? "",
          parentId: input.parentId,
        }),
      }),
    );
    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) =>
        id === "BW-100"
          ? createIssue({
              status: "closed",
              description: "Goal: complete the integrated scope.",
              children: [createIssue({ id: "BW-101", type: "task", status: "closed" })],
            })
          : createIssue({ id: "BW-101", type: "task", status: "closed" }),
      ),
      history: vi.fn(async () => []),
      list: vi.fn(async () => existingIssues),
      createIssue: createIssueMock,
      ready: options.ready ?? vi.fn().mockResolvedValue([]),
    });
    const gitRunner = createGitRunner([
      { sha: "commit-sha", subject: "Implement task", paths: ["src/task.ts"] },
    ]);
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "bash" && args.join(" ") === "-lc echo scope-ok") {
        return ok("scope-ok\n");
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
        return ok(JSON.stringify(options.reviewer));
      }
      return gitRunner(command, args);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...currentBranchVerificationConfig(false),
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
      },
      adapter,
      epicId: "BW-100",
      options: {
        workers: 1,
        until: "blocked",
        dryRun: false,
        maxCycles: options.maxCycles ?? 1,
        pollIntervalMs: 0,
        noSpawn: false,
      },
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });
    return { summary, createIssueMock, registryPath };
  }

  it("creates blocking fix-forward child tasks and keeps verified workers verified", async () => {
    const { summary, createIssueMock, registryPath } = await runScopeReviewScenario({
      reviewer: {
        summary: "needs fix",
        findings: [
          {
            file: "src/task.ts",
            issue: "Epic goal is still incomplete",
            suggestion: "Add the missing scope behavior",
            severity: "fix",
          },
        ],
      },
    });

    expect(createIssueMock).toHaveBeenCalledTimes(1);
    expect(createIssueMock.mock.calls[0]?.[1]).toMatchObject({ parentId: "BW-100", priority: 1 });
    expect(createIssueMock.mock.calls[0]?.[1].description).toContain(
      "scope-review-finding-signature:",
    );
    expect(summary.notes.join("\n")).toContain("blocking fix-forward task");
    expect((await loadWorkerRegistry(registryPath))[0]).toMatchObject({ status: "verified" });
  });

  it("files non-blocking scope review findings without blocking completion", async () => {
    const { summary, createIssueMock } = await runScopeReviewScenario({
      reviewer: {
        summary: "non-blocking follow-up",
        findings: [
          {
            file: "docs/task.md",
            issue: "Documentation should mention the new behavior",
            suggestion: "File docs follow-up",
            severity: "nit",
          },
        ],
      },
    });

    expect(summary.stopReason).toBe("completed");
    expect(createIssueMock).toHaveBeenCalledTimes(1);
    const createdInput = createIssueMock.mock.calls[0]?.[1];
    expect(createdInput).toMatchObject({ priority: 3 });
    expect(createdInput).not.toHaveProperty("parentId");
    expect(summary.notes.join("\n")).toContain("non-blocking follow-up");
  });

  it("completes on restart with an existing non-blocking scope review follow-up outside the epic", async () => {
    const signature = "2c714a51200b9efb";
    const existingFileFollowUp = createIssue({
      id: "BW-FILE-1",
      type: "task",
      status: "open",
      title: `Follow up scope review: Documentation should mention the new behavior (${signature})`,
      description: `Parent epic: BW-100 Epic\nscope-review-classification: file\nscope-review-finding-signature: ${signature}`,
      parentId: undefined,
    });
    const readyMock = vi.fn(async (_cwd: string, scopeId?: string) =>
      scopeId === "BW-100" && existingFileFollowUp.parentId === "BW-100"
        ? [stripChildren(existingFileFollowUp)]
        : [],
    );
    const { summary, createIssueMock, registryPath } = await runScopeReviewScenario({
      existingIssues: [existingFileFollowUp],
      ready: readyMock,
      reviewer: {
        summary: "same non-blocking follow-up",
        findings: [
          {
            file: "docs/task.md",
            issue: "Documentation should mention the new behavior",
            suggestion: "File docs follow-up",
            severity: "nit",
          },
        ],
      },
    });

    expect(summary.stopReason).toBe("completed");
    expect(createIssueMock).not.toHaveBeenCalled();
    expect(readyMock).toHaveBeenCalledWith(expect.any(String), "BW-100");
    const registry = await loadWorkerRegistry(registryPath);
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({ status: "verified" });
  });

  it("rejects invalid scope review feedback and completes", async () => {
    const { summary, createIssueMock } = await runScopeReviewScenario({
      reviewer: {
        summary: "false alarm",
        findings: [
          {
            file: "src/task.ts",
            issue: "False positive: reviewer confused old behavior",
            suggestion: "No action",
            severity: "fix",
          },
        ],
      },
    });

    expect(summary.stopReason).toBe("completed");
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("routes to attention after two scope-review fix-forward rounds", async () => {
    const existingIssues = [
      createIssue({
        id: "BW-FIX-1",
        parentId: "BW-100",
        description:
          "scope-review-fix-round: 1\nscope-review-classification: fix\nscope-review-finding-signature: one",
      }),
      createIssue({
        id: "BW-FIX-2",
        parentId: "BW-100",
        description:
          "scope-review-fix-round: 2\nscope-review-classification: fix\nscope-review-finding-signature: two",
      }),
    ];
    const { summary, createIssueMock } = await runScopeReviewScenario({
      existingIssues,
      reviewer: {
        summary: "still broken",
        findings: [
          {
            file: "src/task.ts",
            issue: "Epic goal is still incomplete",
            suggestion: "Escalate",
            severity: "fix",
          },
        ],
      },
    });

    expect(summary.stopReason).toBe("attention");
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("deduplicates repeated scope-review follow-up task creation", async () => {
    const signature = "ba1f991f3b3c1d80";
    const existingIssues = [
      createIssue({
        id: "BW-FIX-1",
        parentId: "BW-100",
        description: `scope-review-fix-round: 1\nscope-review-classification: fix\nscope-review-finding-signature: ${signature}`,
      }),
    ];
    const { createIssueMock } = await runScopeReviewScenario({
      existingIssues,
      reviewer: {
        summary: "same finding",
        findings: [
          {
            file: "src/task.ts",
            issue: "Epic goal is still incomplete",
            suggestion: "Add the missing scope behavior",
            severity: "fix",
          },
        ],
      },
    });

    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("stops as attention when inline verification routes a worker to attention", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-inline-attention-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      await createCurrentBranchRuntimeWorker(repoRoot, {
        status: "exited",
        ticketStatus: "closed",
        launchHead: "base-sha",
      }),
    ]);

    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) =>
        id === "BW-100"
          ? createIssue({
              children: [createIssue({ id: "BW-101", type: "task", status: "closed" })],
            })
          : createIssue({ id: "BW-101", type: "task", status: "closed" }),
      ),
      ready: vi.fn().mockResolvedValue([]),
    });
    const gitRunner = createGitRunner([]);
    const runner = vi.fn(async (command: string, args: string[]) => gitRunner(command, args));

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...currentBranchVerificationConfig(false),
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("attention");
    expect(summary.workerSummary.attention).toBe(1);
    expect(runner).not.toHaveBeenCalledWith("bash", ["-lc", "echo scope-ok"], expect.anything());
  });

  it("does not complete a closed scope while workers are still active", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-active-scope-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    const worker = await createCurrentBranchRuntimeWorker(repoRoot, {
      status: "running",
      ticketStatus: "closed",
    });
    await writeFile(worker.stateFile, "running\n", "utf8");
    await saveWorkerRegistry(registryPath, [worker]);

    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) =>
        id === "BW-100"
          ? createIssue({
              status: "closed",
              children: [createIssue({ id: "BW-101", type: "task", status: "closed" })],
            })
          : createIssue({ id: "BW-101", type: "task", status: "closed" }),
      ),
      ready: vi.fn().mockResolvedValue([]),
    });
    const runner = vi.fn(async () => ok("scope-ok\n"));

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...currentBranchVerificationConfig(false),
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("max-cycles");
    expect(summary.workerSummary.active).toBe(1);
    expect(runner).not.toHaveBeenCalled();
  });

  it("runs dirty-state remediation at quiescence and cleans generated artifacts before validation", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-dirty-clean-"));
    await mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await writeFile(path.join(repoRoot, "dist", "cache.tmp"), "generated\n", "utf8");
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      createWorker({
        status: "landed",
        ticketStatus: "closed",
        validationStatus: "passed",
        commitShas: ["abc123"],
        touchedPaths: ["src/done.ts"],
      }),
    ]);

    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) =>
        id === "BW-100"
          ? createIssue({
              status: "closed",
              children: [createIssue({ id: "BW-101", type: "task", status: "closed" })],
            })
          : createIssue({ id: "BW-101", type: "task", status: "closed" }),
      ),
      ready: vi.fn().mockResolvedValue([]),
    });
    let statusCalls = 0;
    let validationCalls = 0;
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") {
        statusCalls += 1;
        return ok(statusCalls === 1 ? "?? dist/cache.tmp\n" : "");
      }
      if (command === "git" && (args[0] === "diff" || args[0] === "log")) {
        return ok("");
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
        return ok(
          JSON.stringify({
            decisions: [
              {
                path: "dist/cache.tmp",
                classification: "generated-artifact",
                rationale: "build output residue",
                action: { type: "delete", paths: ["dist/cache.tmp"] },
              },
            ],
          }),
        );
      }
      if (command === "bash" && args[1] === "echo scope-ok") {
        validationCalls += 1;
        return ok("scope-ok\n");
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("completed");
    expect(validationCalls).toBe(1);
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    const artifactDir = path.join(repoRoot, DEFAULT_CONFIG.storage.runtimeDir, "dirty-state");
    const logFile = (await readdir(artifactDir)).find((entry) =>
      entry.endsWith("remediation-log.md"),
    );
    expect(logFile).toBeTruthy();
    const log = await readFile(path.join(artifactDir, logFile as string), "utf8");
    expect(log).toContain("path=dist/cache.tmp");
    expect(log).toContain("classification=generated-artifact");
    expect(log).toContain("command=rm -rf -- dist/cache.tmp");
    expect(log).toContain("<clean>");
  });

  it("commits approved valid partial work path-specifically before validation", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-dirty-commit-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      createWorker({ status: "landed", ticketStatus: "closed", validationStatus: "passed" }),
    ]);
    const adapter = createAdapter({
      show: vi.fn(async () => createIssue({ status: "closed", children: [] })),
      ready: vi.fn().mockResolvedValue([]),
    });
    let statusCalls = 0;
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") {
        statusCalls += 1;
        return ok(statusCalls === 1 ? " M src/partial.ts\n" : "");
      }
      if (command === "git" && (args[0] === "diff" || args[0] === "log")) {
        return ok("");
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
        return ok(
          JSON.stringify({
            decisions: [
              {
                path: "src/partial.ts",
                classification: "valid-partial-work",
                rationale: "complete ticket-related fix left unstaged",
                action: {
                  type: "commit",
                  paths: ["src/partial.ts"],
                  message: "fix: preserve partial work BW-101",
                },
              },
            ],
          }),
        );
      }
      if (command === "git" && args[0] === "add") {
        expect(args).toEqual(["add", "--", "src/partial.ts"]);
        return ok("");
      }
      if (command === "git" && args[0] === "commit") {
        expect(args).toEqual(["commit", "-m", "fix: preserve partial work BW-101"]);
        return ok("[main abc123] fix\n");
      }
      if (command === "bash" && args[1] === "echo scope-ok") {
        return ok("scope-ok\n");
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("completed");
    expect(runner).toHaveBeenCalledWith("git", ["add", "--", "src/partial.ts"], expect.anything());
    expect(runner).toHaveBeenCalledWith(
      "git",
      ["commit", "-m", "fix: preserve partial work BW-101"],
      expect.anything(),
    );
  });

  it("routes unclear source-like untracked files to attention without validation", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-dirty-source-"));
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "new.ts"), "export const x = 1;\n", "utf8");
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      createWorker({ status: "landed", ticketStatus: "closed", validationStatus: "passed" }),
    ]);
    const adapter = createAdapter({
      show: vi.fn(async () =>
        createIssue({
          status: "closed",
          children: [createIssue({ id: "BW-101", type: "task", status: "closed" })],
        }),
      ),
      ready: vi.fn().mockResolvedValue([]),
    });
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") {
        return ok("?? src/new.ts\n");
      }
      if (command === "git" && (args[0] === "diff" || args[0] === "log")) {
        return ok("");
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
        return ok(
          JSON.stringify({
            decisions: [
              {
                path: "src/new.ts",
                classification: "unsafe-unknown",
                rationale: "source-like untracked work has unclear provenance",
                action: { type: "delete", paths: ["src/new.ts"] },
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("attention");
    expect(runner).not.toHaveBeenCalledWith("bash", ["-lc", "echo scope-ok"], expect.anything());
  });

  it("routes unsafe or unknown dirty-state classifications to attention without executing actions", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-dirty-unsafe-class-"));
    await mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "dist", "cache.tmp"), "generated\n", "utf8");
    await writeFile(path.join(repoRoot, "src", "partial.ts"), "export const x = 1;\n", "utf8");
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      createWorker({ status: "landed", ticketStatus: "closed", validationStatus: "passed" }),
    ]);
    const adapter = createAdapter({
      show: vi.fn(async () => createIssue({ status: "closed", children: [] })),
      ready: vi.fn().mockResolvedValue([]),
    });
    let validationCalls = 0;
    let executableActionCalls = 0;
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") {
        return ok(" M src/partial.ts\n?? dist/cache.tmp\n");
      }
      if (command === "git" && (args[0] === "diff" || args[0] === "log")) {
        return ok("");
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
        return ok(
          JSON.stringify({
            decisions: [
              {
                path: "src/partial.ts",
                classification: "unsafe-unknown",
                rationale: "reviewer could not prove this is safe to commit",
                action: {
                  type: "commit",
                  paths: ["src/partial.ts"],
                  message: "fix: unsafe commit should not happen",
                },
              },
              {
                path: "dist/cache.tmp",
                classification: "model-invented-safe-ish",
                rationale: "unrecognized classifications must not be trusted",
                action: { type: "delete", paths: ["dist/cache.tmp"] },
              },
            ],
          }),
        );
      }
      if (command === "git" && ["add", "commit", "restore"].includes(args[0] ?? "")) {
        executableActionCalls += 1;
        return ok("");
      }
      if (command === "bash" && args[1] === "echo scope-ok") {
        validationCalls += 1;
        return ok("scope-ok\n");
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("attention");
    expect(executableActionCalls).toBe(0);
    expect(validationCalls).toBe(0);
    expect(existsSync(path.join(repoRoot, "dist", "cache.tmp"))).toBe(true);
    const artifactDir = path.join(repoRoot, DEFAULT_CONFIG.storage.runtimeDir, "dirty-state");
    const logFile = (await readdir(artifactDir)).find((entry) =>
      entry.endsWith("remediation-log.md"),
    );
    expect(logFile).toBeTruthy();
    const log = await readFile(path.join(artifactDir, logFile as string), "utf8");
    expect(log).toContain("classification unsafe-unknown is not approved for action commit");
    expect(log).toContain(
      "classification model-invented-safe-ish is not approved for action delete",
    );
  });

  it("passes dirty-state evidence with shell metacharacters without shell expansion", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-dirty-shell-safe-"));
    await mkdir(path.join(repoRoot, "dist"), { recursive: true });
    const pwnedPath = path.join(
      os.tmpdir(),
      `pi-bw-shell-pwned-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const backtickPwnedPath = `${pwnedPath}-backtick`;
    const dangerousEvidence = `literal $(touch ${pwnedPath}) and \`touch ${backtickPwnedPath}\``;
    await writeFile(path.join(repoRoot, "dist", "cache.tmp"), dangerousEvidence, "utf8");
    const captureFile = path.join(repoRoot, "captured-prompt.txt");
    const reviewerScript = path.join(repoRoot, "dirty-reviewer.js");
    await writeFile(
      reviewerScript,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(captureFile)}, process.argv[2] ?? "", "utf8");
process.stdout.write(${JSON.stringify(
        JSON.stringify({
          decisions: [
            {
              path: "dist/cache.tmp",
              classification: "generated-artifact",
              rationale: "generated residue",
              action: { type: "delete", paths: ["dist/cache.tmp"] },
            },
          ],
        }),
      )});
`,
      "utf8",
    );
    await chmod(reviewerScript, 0o755);
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      createWorker({ status: "landed", ticketStatus: "closed", validationStatus: "passed" }),
    ]);
    const adapter = createAdapter({
      show: vi.fn(async () => createIssue({ status: "closed", children: [] })),
      ready: vi.fn().mockResolvedValue([]),
    });
    let validationCalls = 0;
    const runner = vi.fn(async (command: string, args: string[], options) => {
      if (command === "git" && args[0] === "status") {
        return ok(
          existsSync(path.join(repoRoot, "dist", "cache.tmp")) ? "?? dist/cache.tmp\n" : "",
        );
      }
      if (command === "git" && (args[0] === "diff" || args[0] === "log")) {
        return ok("");
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
        expect(args[1]).not.toContain(pwnedPath);
        return defaultProcessRunner(command, args, options);
      }
      if (command === "bash" && args[1] === "echo scope-ok") {
        validationCalls += 1;
        return ok("scope-ok\n");
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        tmux: { ...DEFAULT_CONFIG.tmux, workerCommand: reviewerScript },
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("completed");
    expect(validationCalls).toBe(1);
    expect(existsSync(pwnedPath)).toBe(false);
    expect(existsSync(backtickPwnedPath)).toBe(false);
    expect(await readFile(captureFile, "utf8")).toContain(dangerousEvidence);
  });

  it("routes dirty-state remediator failure to attention", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-dirty-fail-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      createWorker({ status: "landed", ticketStatus: "closed", validationStatus: "passed" }),
    ]);
    const adapter = createAdapter({
      show: vi.fn(async () => createIssue({ status: "closed", children: [] })),
      ready: vi.fn().mockResolvedValue([]),
    });
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") {
        return ok("?? dist/cache.tmp\n");
      }
      if (command === "git" && (args[0] === "diff" || args[0] === "log")) {
        return ok("");
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
        throw new Error("remediator unavailable");
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("attention");
    expect(summary.notes.join("\n")).toContain("Dirty-state remediation failed");
  });

  it("requires clean status after remediation before validation", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-dirty-post-"));
    await mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await writeFile(path.join(repoRoot, "dist", "cache.tmp"), "generated\n", "utf8");
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      createWorker({ status: "landed", ticketStatus: "closed", validationStatus: "passed" }),
    ]);
    const adapter = createAdapter({
      show: vi.fn(async () => createIssue({ status: "closed", children: [] })),
      ready: vi.fn().mockResolvedValue([]),
    });
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") {
        return ok("?? dist/cache.tmp\n");
      }
      if (command === "git" && (args[0] === "diff" || args[0] === "log")) {
        return ok("");
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
        return ok(
          JSON.stringify({
            decisions: [
              {
                path: "dist/cache.tmp",
                classification: "generated-artifact",
                rationale: "generated residue",
                action: { type: "delete", paths: ["dist/cache.tmp"] },
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("attention");
    expect(runner).not.toHaveBeenCalledWith("bash", ["-lc", "echo scope-ok"], expect.anything());
  });

  it("keeps worktree landed workers on the existing completion path", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-worktree-complete-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      createWorker({
        status: "landed",
        ticketStatus: "closed",
        validationStatus: "passed",
      }),
    ]);

    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) =>
        id === "BW-100"
          ? createIssue({
              status: "closed",
              children: [createIssue({ id: "BW-101", type: "task", status: "closed" })],
            })
          : createIssue({ id: "BW-101", type: "task", status: "closed" }),
      ),
      ready: vi.fn().mockResolvedValue([]),
    });
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") {
        return ok("");
      }
      expect(command).toBe("bash");
      expect(args).toEqual(["-lc", "echo scope-ok"]);
      return ok("scope-ok\n");
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("completed");
    expect(summary.workerSummary.landed).toBe(1);
    expect(summary.workerSummary.successfulTerminal).toBe(1);
  });

  it("creates attribution-aware fix-forward child tasks for current-branch scope validation failures", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-scope-validation-fix-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      await createCurrentBranchRuntimeWorker(repoRoot, {
        status: "verified",
        ticketStatus: "closed",
        validationStatus: "passed",
        landingVerifiedAt: "2026-04-14T00:10:00.000Z",
        landingVerification: "Current-branch worker verified.",
        launchHead: "base-sha",
        commitShas: ["abc123"],
        touchedPaths: ["src/task.ts", "src/task.test.ts"],
      }),
    ]);

    const createdIssues: BeadworkIssue[] = [];
    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) =>
        id === "BW-100"
          ? createIssue({
              id: "BW-100",
              title: "Epic",
              description: "Ship the integrated current-branch feature safely.",
              status: "closed",
              children: [createIssue({ id: "BW-101", type: "task", status: "closed" })],
            })
          : createIssue({ id: "BW-101", type: "task", title: "Task", status: "closed" }),
      ),
      history: vi.fn(async (_cwd: string, id: string) => [
        { intent: "comment", message: `handoff context for ${id}: committed abc123` },
      ]),
      list: vi.fn(async () => createdIssues),
      createIssue: vi.fn(async (_cwd, input) => {
        const issue = createIssue({
          id: `BW-100.${createdIssues.length + 1}`,
          title: input.title,
          description: input.description ?? "",
          status: "open",
          type: input.type ?? "task",
          priority: input.priority ?? 1,
          parentId: input.parentId,
        });
        createdIssues.push(stripChildren(issue));
        return { issue };
      }),
      ready: vi.fn().mockResolvedValue([]),
    });

    let validationCalls = 0;
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") {
        return ok("");
      }
      if (command === "git" && args[0] === "log") {
        return ok("abc123 Implement task\n");
      }
      if (command === "git" && args[0] === "show") {
        return ok("Implement task\n");
      }
      if (command === "bash" && args[0] === "-lc" && args[1] === "echo scope-ok") {
        validationCalls += 1;
        return {
          stdout: "FAIL src/task.test.ts\n",
          stderr: "expected integrated behavior\n",
          code: 1,
        };
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
        return ok(
          JSON.stringify({
            classification: "create-fix-forward",
            rationale: "Failure maps to BW-101 commit abc123 and touched test path.",
            safetyNotes: "Create a new child task only; leave verified worker untouched.",
            suspectedTickets: ["BW-101"],
            suspectedCommits: ["abc123"],
            files: ["src/task.test.ts", "src/task.ts"],
            tests: ["src/task.test.ts"],
            title: "Repair integrated task behavior",
            successCriteria: ["echo scope-ok passes"],
          }),
        );
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...currentBranchVerificationConfig(false),
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
      },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("max-cycles");
    expect(validationCalls).toBe(2);
    expect(adapter.createIssue).toHaveBeenCalledTimes(1);
    expect(summary.notes.join("\n")).toContain("command=echo scope-ok");
    expect(summary.notes.join("\n")).toContain("exitCode=1");
    expect(createdIssues[0]?.description).toContain("scope-validation-signature:");
    expect(createdIssues[0]?.description).toContain("FAIL src/task.test.ts");
    expect(createdIssues[0]?.description).toContain("Tickets: BW-101");
    expect(createdIssues[0]?.description).toContain("Commits: abc123");
    expect(createdIssues[0]?.description).toContain("Files: src/task.test.ts, src/task.ts");
    expect((await loadWorkerRegistry(registryPath))[0]).toMatchObject({ status: "verified" });

    const artifactDir = path.join(repoRoot, DEFAULT_CONFIG.storage.runtimeDir, "scope-validation");
    const artifacts = await readdir(artifactDir);
    const evidence = await readFile(
      path.join(artifactDir, artifacts.find((entry) => entry.includes("-evidence")) as string),
      "utf8",
    );
    expect(evidence).toContain("Ship the integrated current-branch feature safely.");
    expect(evidence).toContain("command: echo scope-ok");
    expect(evidence).toContain("exitCode: 1");
    expect(evidence).toContain("FAIL src/task.test.ts");
    expect(evidence).toContain("BW-101");
    expect(evidence).toContain("abc123");
    expect(evidence).toContain("Implement task");
    expect(evidence).toContain("src/task.ts");
    expect(evidence).toContain("handoff context");
    expect(evidence).toContain("## git status --porcelain");
    expect(evidence).toContain("## recent git log --oneline");
    const log = await readFile(
      path.join(
        artifactDir,
        artifacts.find((entry) => entry.includes("-fix-forward-log")) as string,
      ),
      "utf8",
    );
    expect(log).toContain("relatedTickets: BW-101");
    expect(log).toContain("relatedCommits: abc123");
    expect(log).toContain("rationale: Failure maps to BW-101");
  });

  it.each([
    {
      name: "empty attribution",
      decision: {
        classification: "create-fix-forward",
        rationale: "Failure probably belongs to the completed task, but no attribution is listed.",
        safetyNotes: "Create follow-up work.",
        suspectedTickets: [],
        suspectedCommits: [],
        files: ["src/task.test.ts"],
        tests: ["src/task.test.ts"],
        title: "Repair integrated task behavior",
        successCriteria: ["echo scope-ok passes"],
      },
      expectedReason: "missing suspectedTickets attribution",
    },
    {
      name: "hallucinated ticket/commit attribution",
      decision: {
        classification: "create-fix-forward",
        rationale: "Failure maps to BW-999 and deadbeef.",
        safetyNotes: "Create follow-up work.",
        suspectedTickets: ["BW-999"],
        suspectedCommits: ["deadbeef"],
        files: ["src/task.test.ts"],
        tests: ["src/task.test.ts"],
        title: "Repair integrated task behavior",
        successCriteria: ["echo scope-ok passes"],
      },
      expectedReason: "unknown suspectedTickets: BW-999",
    },
  ])("routes create-fix-forward with $name to attention without creating child tasks", async ({
    decision,
    expectedReason,
  }) => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-scope-validation-attr-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      await createCurrentBranchRuntimeWorker(repoRoot, {
        status: "verified",
        ticketStatus: "closed",
        validationStatus: "passed",
        landingVerifiedAt: "2026-04-14T00:10:00.000Z",
        launchHead: "base-sha",
        commitShas: ["abc123"],
        touchedPaths: ["src/task.ts"],
      }),
    ]);

    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) =>
        id === "BW-100"
          ? createIssue({
              id: "BW-100",
              status: "closed",
              children: [createIssue({ id: "BW-101", type: "task", status: "closed" })],
            })
          : createIssue({ id: "BW-101", type: "task", status: "closed" }),
      ),
      history: vi.fn(async () => []),
      list: vi.fn(async () => []),
      createIssue: vi.fn(),
      ready: vi.fn().mockResolvedValue([]),
    });
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") {
        return ok("");
      }
      if (command === "git" && args[0] === "log") {
        return ok("abc123 Implement task\n");
      }
      if (command === "git" && args[0] === "show") {
        return ok("Implement task\n");
      }
      if (command === "bash" && args[0] === "-lc" && args[1] === "echo scope-ok") {
        return { stdout: "FAIL src/task.test.ts\n", stderr: "expected behavior\n", code: 1 };
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
        return ok(JSON.stringify(decision));
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...currentBranchVerificationConfig(false),
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("attention");
    expect(adapter.createIssue).not.toHaveBeenCalled();
    expect(summary.notes.join("\n")).toContain("attribution was ambiguous/unsafe");
    expect((await loadWorkerRegistry(registryPath))[0]).toMatchObject({ status: "verified" });

    const artifactDir = path.join(repoRoot, DEFAULT_CONFIG.storage.runtimeDir, "scope-validation");
    const artifacts = await readdir(artifactDir);
    const attentionLog = await readFile(
      path.join(artifactDir, artifacts.find((entry) => entry.includes("-attention-log")) as string),
      "utf8",
    );
    expect(attentionLog).toContain("without verified attribution support");
    expect(attentionLog).toContain(expectedReason);
  });

  it("routes ambiguous current-branch scope validation failures to attention", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-scope-validation-attn-"));
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    await saveWorkerRegistry(registryPath, [
      await createCurrentBranchRuntimeWorker(repoRoot, {
        status: "verified",
        ticketStatus: "closed",
        validationStatus: "passed",
        landingVerifiedAt: "2026-04-14T00:10:00.000Z",
        launchHead: "base-sha",
        commitShas: ["abc123"],
        touchedPaths: ["src/task.ts"],
      }),
    ]);
    const adapter = createAdapter({
      show: vi.fn(async (_cwd: string, id: string) =>
        id === "BW-100"
          ? createIssue({
              status: "closed",
              children: [createIssue({ id: "BW-101", status: "closed" })],
            })
          : createIssue({ id: "BW-101", type: "task", status: "closed" }),
      ),
      history: vi.fn(async () => []),
      list: vi.fn(async () => []),
      createIssue: vi.fn(),
      ready: vi.fn().mockResolvedValue([]),
    });
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") {
        return ok("");
      }
      if (command === "git" && args[0] === "log") {
        return ok("abc123 Implement task\n");
      }
      if (command === "git" && args[0] === "show") {
        return ok("Implement task\n");
      }
      if (command === "bash" && args[0] === "-lc" && args[1] === "echo scope-ok") {
        return { stdout: "", stderr: "opaque infra failure\n", code: 1 };
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
        return ok(
          JSON.stringify({
            classification: "attention",
            rationale: "Output is opaque and attribution is unsafe.",
            safetyNotes: "Do not create speculative child work.",
          }),
        );
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...currentBranchVerificationConfig(false),
        landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
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
      tmuxBackend: createMockTmuxBackend(),
      runner,
    });

    expect(summary.stopReason).toBe("attention");
    expect(adapter.createIssue).not.toHaveBeenCalled();
    expect(summary.notes.join("\n")).toContain("attribution was ambiguous/unsafe");
    expect(summary.notes.join("\n")).not.toContain("Scope validation passed");
    expect((await loadWorkerRegistry(registryPath))[0]).toMatchObject({ status: "verified" });
  });

  it("preserves empty stop behavior for open scopes with no ready work", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-empty-"));
    const adapter = createAdapter({
      show: vi.fn().mockResolvedValue(createIssue()),
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
        until: "empty",
        dryRun: false,
        maxCycles: 1,
        pollIntervalMs: 0,
        noSpawn: false,
      },
      tmuxBackend: createMockTmuxBackend(),
    });

    expect(summary.stopReason).toBe("empty");
  });
});
