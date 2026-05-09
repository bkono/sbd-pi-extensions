import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BeadworkAdapter } from "../../bw.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import { launchTicketWorker, runBoundedEpicLoop } from "../../orchestrator.js";
import type { ProcessResult, ProcessRunner } from "../../process.js";
import { loadWorkerRegistry, resolveWorkerRegistryPath } from "../../registry.js";
import type { TmuxBackend } from "../../tmux.js";
import type { BeadworkConfig, BeadworkIssueDetail } from "../../types.js";

function ok(stdout = ""): ProcessResult {
  return { stdout, stderr: "", code: 0 };
}

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
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
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

function createLaunchAdapter(...issues: BeadworkIssueDetail[]): BeadworkAdapter {
  const issueMap = new Map(issues.map((issue) => [issue.id, issue]));
  return createAdapter({
    show: vi.fn(async (_cwd: string, issueId: string) => {
      const issue = issueMap.get(issueId);
      if (!issue) {
        throw new Error(`unexpected issue ${issueId}`);
      }
      return issue;
    }),
  });
}

function currentBranchConfig(overrides: Partial<BeadworkConfig> = {}): BeadworkConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    workerExecution: {
      ...DEFAULT_CONFIG.workerExecution,
      mode: "current-branch",
      ...overrides.workerExecution,
      review: {
        ...DEFAULT_CONFIG.workerExecution.review,
        ...overrides.workerExecution?.review,
      },
    },
  };
}

function currentBranchConfigWithPoisonedWorktrees(overrides: Partial<BeadworkConfig> = {}) {
  return {
    ...currentBranchConfig(overrides),
    get worktrees() {
      throw new Error("current-branch launch must not consult worktree config");
    },
  } as BeadworkConfig;
}

function createMockTmuxBackend(
  launchWorker?: TmuxBackend["launchWorker"],
): TmuxBackend & { launchWorker: ReturnType<typeof vi.fn> } {
  return {
    ensureSession: vi.fn().mockResolvedValue({ sessionName: "pi-bw", created: false }),
    launchWorker: vi.fn(
      launchWorker ??
        (async (input) => ({
          sessionName: input.sessionName,
          windowName: `${input.workerId}-window`,
          paneId: `%${input.workerId}`,
          launchCommand: input.launchCommand,
        })),
    ),
    inspectWorker: vi.fn().mockResolvedValue({ exists: true }),
    cleanupWorker: vi.fn().mockResolvedValue(undefined),
  };
}

function createCurrentBranchRunner(input: { branchName?: string; head?: string } = {}): {
  calls: string[];
  runner: ProcessRunner;
} {
  const calls: string[] = [];
  const branchName = input.branchName ?? "feature/current-branch";
  const head = input.head ?? "abc123launch";
  const runner: ProcessRunner = vi.fn(async (command, args, options) => {
    const rendered = `${command} ${args.join(" ")}`;
    calls.push(rendered);
    expect(options?.cwd, `${rendered} must probe the repo root/current checkout`).toBeTruthy();

    if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
      return ok(`${branchName}\n`);
    }
    if (command === "git" && args.join(" ") === "rev-parse HEAD") {
      return ok(`${head}\n`);
    }
    throw new Error(`unexpected current-branch process call: ${rendered}`);
  });

  return { calls, runner };
}

function runGit(repoRoot: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

async function createRealRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-real-"));
  runGit(repoRoot, ["init"]);
  await writeFile(path.join(repoRoot, "README.md"), "# current branch launch\n", "utf8");
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "init"]);
  runGit(repoRoot, ["checkout", "-b", "feature/current-branch-launch"]);
  return repoRoot;
}

describe("Phase 2 current-branch launch regressions", () => {
  it("launches in the current checkout without worktree prep, clean gates, or worktree-only fields", async () => {
    // WHY: current-branch workers intentionally share the live branch. A clean-checkout
    // gate, worktree bootstrap, or fake worktreePath would reintroduce the old isolated
    // execution contract and make broad cleanup/staging mistakes more likely.
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-launch-"));
    const ticket = createIssue({
      id: "BW-201",
      title: "Current branch task",
      type: "task",
      parentId: "BW-200",
      description: "Keep launch on the shared current branch.",
    });
    const epic = createIssue({ id: "BW-200", title: "Current branch epic", type: "epic" });
    const { calls, runner } = createCurrentBranchRunner();
    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    const config = currentBranchConfigWithPoisonedWorktrees({
      landing: {
        ...DEFAULT_CONFIG.landing,
        review: { ...DEFAULT_CONFIG.landing.review, enabled: true },
      },
      workerExecution: {
        ...DEFAULT_CONFIG.workerExecution,
        mode: "current-branch",
        review: { enabled: false },
      },
    });
    const tmuxBackend = createMockTmuxBackend(async (input) => {
      const pendingRecords = await loadWorkerRegistry(registryPath);
      expect(
        pendingRecords[0],
        "branchName and launchHead must be recorded before tmux starts the worker",
      ).toMatchObject({
        ticketId: ticket.id,
        status: "launching",
        executionMode: "current-branch",
        checkoutPath: repoRoot,
        branchName: "feature/current-branch",
        launchHead: "abc123launch",
      });
      expect("worktreePath" in (pendingRecords[0] ?? {})).toBe(false);
      return {
        sessionName: input.sessionName,
        windowName: `${input.workerId}-window`,
        paneId: "%42",
        launchCommand: input.launchCommand,
      };
    });

    const worker = await launchTicketWorker({
      cwd: repoRoot,
      repoRoot,
      config,
      adapter: createLaunchAdapter(ticket, epic),
      ticketId: ticket.id,
      tmuxBackend,
      processRunner: runner,
    });

    expect(tmuxBackend.launchWorker).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: repoRoot }),
    );
    expect(calls, "current-branch launch must not prepare/check a worktree or clean gate").toEqual([
      "git rev-parse --abbrev-ref HEAD",
      "git rev-parse HEAD",
    ]);
    expect(calls.some((call) => /\b(worktree|status)\b/.test(call))).toBe(false);
    expect(worker).toMatchObject({
      executionMode: "current-branch",
      checkoutPath: repoRoot,
      branchName: "feature/current-branch",
      launchHead: "abc123launch",
      status: "running",
    });
    expect(worker.reviewStatus).toBeUndefined();
    expect("worktreePath" in worker).toBe(false);
    expect(worker.runtimeDir).toContain(
      path.join(repoRoot, ".pi", "beadwork", "workers", "runtime"),
    );
    expect(existsSync(path.join(worker.runtimeDir, "scratch"))).toBe(true);

    const prompt = await readFile(worker.promptFile, "utf8");
    expect(prompt).toContain("Run `bw start BW-201` before beginning work");
    expect(prompt).toContain("Stage and commit only the specific files intentionally changed");
    expect(prompt).toContain("Avoid broad staging commands such as `git add -A`");
    expect(prompt).toContain("Do not stash, reset, clean, discard");
    expect(prompt).not.toContain("worktree");

    const records = await loadWorkerRegistry(registryPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workerId: worker.workerId,
      executionMode: "current-branch",
      checkoutPath: repoRoot,
      branchName: "feature/current-branch",
      launchHead: "abc123launch",
      status: "running",
    });
    expect(records[0]?.reviewStatus).toBeUndefined();
    expect("worktreePath" in (records[0] ?? {})).toBe(false);
  });

  it("launches from a real dirty current branch with untracked files", async () => {
    // WHY: live current-branch workers are allowed to start while the operator or other
    // workers have unrelated dirty/untracked state; beadwork coordination replaces a
    // brittle pre-launch cleanliness gate.
    const repoRoot = await createRealRepo();
    await writeFile(path.join(repoRoot, "README.md"), "# modified before launch\n", "utf8");
    await writeFile(path.join(repoRoot, "untracked-notes.md"), "do not block launch\n", "utf8");
    const ticket = createIssue({ id: "BW-202", title: "Dirty launch", type: "task" });
    const tmuxBackend = createMockTmuxBackend();

    const worker = await launchTicketWorker({
      cwd: repoRoot,
      repoRoot,
      config: currentBranchConfig(),
      adapter: createLaunchAdapter(ticket),
      ticketId: ticket.id,
      tmuxBackend,
    });

    expect(worker.executionMode).toBe("current-branch");
    expect(worker.checkoutPath).toBe(repoRoot);
    expect(worker.branchName).toBe("feature/current-branch-launch");
    expect(worker.launchHead).toMatch(/^[0-9a-f]{40}$/);
    expect(tmuxBackend.launchWorker).toHaveBeenCalledTimes(1);
  });

  it("rejects detached HEAD by default but records detached identity when explicitly allowed", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-detached-launch-"));
    const rejectedTicket = createIssue({ id: "BW-203", title: "Reject detached", type: "task" });
    const allowedTicket = createIssue({ id: "BW-204", title: "Allow detached", type: "task" });
    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return ok("HEAD\n");
      }
      if (args.join(" ") === "rev-parse HEAD") {
        return ok("detached-sha\n");
      }
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    });
    const rejectingTmux = createMockTmuxBackend();

    await expect(
      launchTicketWorker({
        cwd: repoRoot,
        repoRoot,
        config: currentBranchConfig(),
        adapter: createLaunchAdapter(rejectedTicket),
        ticketId: rejectedTicket.id,
        tmuxBackend: rejectingTmux,
        processRunner: runner,
      }),
    ).rejects.toThrow(/detached HEAD/);
    expect(rejectingTmux.launchWorker).not.toHaveBeenCalled();

    const allowingTmux = createMockTmuxBackend();
    const worker = await launchTicketWorker({
      cwd: repoRoot,
      repoRoot,
      config: currentBranchConfig({
        workerExecution: {
          ...DEFAULT_CONFIG.workerExecution,
          mode: "current-branch",
          allowDetachedHead: true,
        },
      }),
      adapter: createLaunchAdapter(allowedTicket),
      ticketId: allowedTicket.id,
      tmuxBackend: allowingTmux,
      processRunner: runner,
    });

    expect(worker).toMatchObject({
      executionMode: "current-branch",
      branchName: "HEAD",
      launchHead: "detached-sha",
    });
    const prompt = await readFile(worker.promptFile, "utf8");
    expect(prompt).toContain("Current branch: HEAD");
    expect(
      (
        await loadWorkerRegistry(
          resolveWorkerRegistryPath(repoRoot, DEFAULT_CONFIG.storage.workerRegistryFile),
        )
      ).at(-1),
    ).toMatchObject({
      ticketId: allowedTicket.id,
      branchName: "HEAD",
      launchHead: "detached-sha",
    });
  });

  it("/bw run --workers N launches multiple current-branch workers without lock files", async () => {
    // WHY: the run loop should bound concurrency by registry state only. Current-branch
    // launch must not need extra IPC, lock files, or reservations before workers can start.
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-run-"));
    const readyTickets = [1, 2, 3].map((index) =>
      createIssue({
        id: `BW-30${index}`,
        title: `Current branch task ${index}`,
        type: "task",
        parentId: "BW-300",
      }),
    );
    const epic = createIssue({
      id: "BW-300",
      title: "Current branch run epic",
      type: "epic",
      children: readyTickets,
    });
    const adapter = createLaunchAdapter(epic, ...readyTickets);
    vi.mocked(adapter.ready).mockResolvedValue(readyTickets);
    const { calls, runner } = createCurrentBranchRunner({ head: "shared-run-head" });
    const tmuxBackend = createMockTmuxBackend();

    const summary = await runBoundedEpicLoop({
      cwd: repoRoot,
      repoRoot,
      config: currentBranchConfig(),
      adapter,
      epicId: epic.id,
      options: {
        workers: 3,
        until: "blocked",
        dryRun: false,
        maxCycles: 1,
        pollIntervalMs: 0,
        noSpawn: false,
      },
      tmuxBackend,
      runner,
    });

    expect(summary.launched).toEqual(["BW-301", "BW-302", "BW-303"]);
    expect(summary.notes).toEqual([
      `Cycle 1: launched current-branch worker for BW-301 at checkoutPath ${repoRoot}.`,
      `Cycle 1: launched current-branch worker for BW-302 at checkoutPath ${repoRoot}.`,
      `Cycle 1: launched current-branch worker for BW-303 at checkoutPath ${repoRoot}.`,
    ]);
    expect(tmuxBackend.launchWorker).toHaveBeenCalledTimes(3);
    expect(existsSync(path.join(repoRoot, ".pi", "beadwork", "locks"))).toBe(false);
    expect(
      calls.some((call) => /\b(flock|lock|lease|reservation|worktree|status)\b/.test(call)),
    ).toBe(false);
    const records = await loadWorkerRegistry(
      resolveWorkerRegistryPath(repoRoot, DEFAULT_CONFIG.storage.workerRegistryFile),
    );
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.executionMode === "current-branch")).toBe(true);
    expect(records.every((record) => !("worktreePath" in record))).toBe(true);
  });

  it("preserves worktree-mode launch behavior when workerExecution.mode is worktree", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-bw-worktree-preserved-"));
    const repoRoot = path.join(tmp, "repo");
    const worktreeBase = path.join(tmp, "worktrees");
    await mkdir(repoRoot, { recursive: true });
    const ticket = createIssue({ id: "BW-401", title: "Worktree task", type: "task" });
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "branch") {
        return ok("");
      }
      if (command === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[4] ?? "", { recursive: true });
        return ok("");
      }
      throw new Error(`unexpected worktree launch command: ${command} ${args.join(" ")}`);
    });
    const tmuxBackend = createMockTmuxBackend();

    const worker = await launchTicketWorker({
      cwd: repoRoot,
      repoRoot,
      config: {
        ...DEFAULT_CONFIG,
        workerExecution: { ...DEFAULT_CONFIG.workerExecution, mode: "worktree" },
        worktrees: { ...DEFAULT_CONFIG.worktrees, baseDir: worktreeBase },
      },
      adapter: createLaunchAdapter(ticket),
      ticketId: ticket.id,
      tmuxBackend,
      processRunner: runner,
    });

    expect(worker.executionMode).toBe("worktree");
    expect(worker.checkoutPath).toBe(worker.worktreePath);
    expect(worker.worktreePath).toContain(worktreeBase);
    expect(tmuxBackend.launchWorker).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: worker.worktreePath }),
    );
    expect(runner).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "add"]),
      expect.objectContaining({ cwd: repoRoot }),
    );
  });

  it("uses current-branch launch metadata in tmux errors instead of worktree paths", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-error-"));
    const ticket = createIssue({ id: "BW-501", title: "Tmux denied", type: "task" });
    const { runner } = createCurrentBranchRunner({ branchName: "main", head: "head501" });
    const tmuxBackend = createMockTmuxBackend();
    tmuxBackend.launchWorker.mockRejectedValueOnce(new Error("tmux pane denied"));

    await expect(
      launchTicketWorker({
        cwd: repoRoot,
        repoRoot,
        config: currentBranchConfig(),
        adapter: createLaunchAdapter(ticket),
        ticketId: ticket.id,
        tmuxBackend,
        processRunner: runner,
      }),
    ).rejects.toThrow(
      `executionMode=current-branch checkoutPath=${repoRoot} branchName=main launchHead=head501`,
    );

    const records = await loadWorkerRegistry(
      resolveWorkerRegistryPath(repoRoot, DEFAULT_CONFIG.storage.workerRegistryFile),
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.lastError).toContain("tmux pane denied");
    expect(records[0]?.lastError).toContain("checkoutPath");
    expect(records[0]?.lastError).not.toContain("worktreePath");
  });

  it("keeps current-branch review launch state independent from landing.review.enabled", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-review-config-"));
    const disabledTicket = createIssue({ id: "BW-601", title: "Worker review off", type: "task" });
    const enabledTicket = createIssue({ id: "BW-602", title: "Worker review on", type: "task" });
    const { runner } = createCurrentBranchRunner();

    const disabledWorker = await launchTicketWorker({
      cwd: repoRoot,
      repoRoot,
      config: currentBranchConfigWithPoisonedWorktrees({
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: { ...DEFAULT_CONFIG.landing.review, enabled: true },
        },
        workerExecution: {
          ...DEFAULT_CONFIG.workerExecution,
          mode: "current-branch",
          review: { enabled: false },
        },
      }),
      adapter: createLaunchAdapter(disabledTicket),
      ticketId: disabledTicket.id,
      tmuxBackend: createMockTmuxBackend(),
      processRunner: runner,
    });

    const enabledWorker = await launchTicketWorker({
      cwd: repoRoot,
      repoRoot,
      config: currentBranchConfigWithPoisonedWorktrees({
        landing: {
          ...DEFAULT_CONFIG.landing,
          review: { ...DEFAULT_CONFIG.landing.review, enabled: false },
        },
        workerExecution: {
          ...DEFAULT_CONFIG.workerExecution,
          mode: "current-branch",
          review: { enabled: true },
        },
      }),
      adapter: createLaunchAdapter(enabledTicket),
      ticketId: enabledTicket.id,
      tmuxBackend: createMockTmuxBackend(),
      processRunner: runner,
    });

    expect(disabledWorker.reviewStatus).toBeUndefined();
    expect(enabledWorker.reviewStatus).toBe("pending");
  });
});
