import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import type { ProcessResult, ProcessRunner } from "../../process.js";
import { normalizeWorkerRecord } from "../../registry.js";
import type { BeadworkConfig, CurrentBranchWorkerRuntime, WorkerStatus } from "../../types.js";
import { prepareWorkerCheckout } from "../../worktree.js";

function ok(stdout = ""): ProcessResult {
  return { stdout, stderr: "", code: 0 };
}

function currentBranchConfig(): BeadworkConfig {
  return {
    ...DEFAULT_CONFIG,
    workerExecution: {
      ...DEFAULT_CONFIG.workerExecution,
      mode: "current-branch",
    },
  };
}

function createCurrentBranchRunner(input: { branchName?: string; head?: string } = {}): {
  calls: string[];
  runner: ProcessRunner;
} {
  const branchName = input.branchName ?? "main";
  const head = input.head ?? "abc123";
  const calls: string[] = [];
  const runner: ProcessRunner = vi.fn(async (command, args) => {
    const rendered = `${command} ${args.join(" ")}`;
    calls.push(rendered);

    if (command !== "git") {
      throw new Error(`unexpected non-git prerequisite: ${rendered}`);
    }

    const gitArgs = args.join(" ");
    if (gitArgs === "rev-parse --abbrev-ref HEAD") {
      return ok(`${branchName}\n`);
    }
    if (gitArgs === "rev-parse HEAD") {
      return ok(`${head}\n`);
    }

    throw new Error(`unexpected current-branch prerequisite: ${rendered}`);
  });

  return { calls, runner };
}

function currentBranchWorker(
  overrides: Partial<CurrentBranchWorkerRuntime> = {},
): CurrentBranchWorkerRuntime {
  return {
    executionMode: "current-branch",
    checkoutPath: "/repo",
    branchName: "main",
    launchHead: "abc123",
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
    status: "running",
    startedAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

function acceptWorkerStatus(status: WorkerStatus): WorkerStatus {
  return status;
}

async function writeProjectConfig(repoRoot: string, config: unknown): Promise<void> {
  await mkdir(path.join(repoRoot, ".pi"), { recursive: true });
  await writeFile(
    path.join(repoRoot, ".pi", "beadwork-config.json"),
    JSON.stringify(config),
    "utf8",
  );
}

afterEach(() => {
  delete process.env.PI_BEADWORK_REVIEW_ENABLED;
  delete process.env.PI_BEADWORK_WORKER_REVIEW_ENABLED;
});

describe("substrate invariants for current-branch worker execution", () => {
  // Phase 1 intentionally covers prepareWorkerCheckout and persisted runtime records only;
  // launchTicketWorker is not wired to current-branch execution until a later phase.
  it("does not require a path reservation system before preparing current-branch checkout", async () => {
    // WHY: current-branch execution deliberately lets beadwork own task coordination;
    // adding a separate path reservation prerequisite would reintroduce planning overhead
    // before a worker can even start.
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-substrate-"));
    const reservationRoot = path.join(repoRoot, ".pi", "beadwork", "reservations");
    const beforeEntries = await readdir(repoRoot);
    const { runner } = createCurrentBranchRunner();

    const result = await prepareWorkerCheckout({
      config: currentBranchConfig(),
      ticketId: "BW-101",
      repoRoot,
      processRunner: runner,
    });

    expect(result.executionMode).toBe("current-branch");
    expect(result.checkoutPath).toBe(repoRoot);
    expect(existsSync(reservationRoot)).toBe(false);
    expect(await readdir(repoRoot)).toEqual(beforeEntries);
  });

  it("does not gate current-branch preparation on a clean checkout", async () => {
    // WHY: current-branch workers are intended to run in the operator's live branch;
    // a git-status cleanliness gate would block useful work whenever the repo already
    // has dirty or untracked files.
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-dirty-"));
    await writeFile(path.join(repoRoot, "untracked-notes.md"), "dirty on purpose\n", "utf8");
    const { calls, runner } = createCurrentBranchRunner();

    const result = await prepareWorkerCheckout({
      config: currentBranchConfig(),
      ticketId: "BW-102",
      repoRoot,
      processRunner: runner,
    });

    expect(result.launchHead).toBe("abc123");
    expect(calls).not.toContain("git status --porcelain");
    expect(calls.every((call) => call.startsWith("git rev-parse"))).toBe(true);
  });

  it("does not consult worktree bootstrap config for current-branch preparation", async () => {
    // WHY: worktree copy/setup/cleanup settings are for isolated worktrees only; leaking
    // them into current-branch mode would make the lightweight path depend on worktree
    // bootstrap semantics it explicitly avoids.
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-noworktree-"));
    const { runner } = createCurrentBranchRunner();
    const config: BeadworkConfig = {
      ...currentBranchConfig(),
      get worktrees() {
        throw new Error("current-branch mode must not read worktree settings");
      },
    };

    await expect(
      prepareWorkerCheckout({
        config,
        ticketId: "BW-103",
        repoRoot,
        processRunner: runner,
      }),
    ).resolves.toMatchObject({ executionMode: "current-branch", checkoutPath: repoRoot });
  });

  it("does not put worktreePath on normalized current-branch runtime records", () => {
    // WHY: setting worktreePath to the repo root would make downstream code treat the
    // live checkout as disposable worker infrastructure, which is the wrong direction.
    const worker = currentBranchWorker();
    const spoofedWorker = { ...worker, worktreePath: "/repo" };

    expect(worker.checkoutPath).toBe("/repo");
    expect("worktreePath" in worker).toBe(false);
    expect("worktreePath" in normalizeWorkerRecord(spoofedWorker)).toBe(false);
  });

  it("keeps proposed process-phase names out of the WorkerStatus union", () => {
    // WHY: these labels describe implementation phases or scheduler decisions, not the
    // small top-level worker lifecycle. Accepting them would invite over-modeled state
    // machines instead of using evidence fields and the existing terminal statuses.
    expect(acceptWorkerStatus("launching")).toBe("launching");
    expect(acceptWorkerStatus("running")).toBe("running");
    expect(acceptWorkerStatus("exited")).toBe("exited");
    expect(acceptWorkerStatus("held")).toBe("held");
    expect(acceptWorkerStatus("landed")).toBe("landed");
    expect(acceptWorkerStatus("verified")).toBe("verified");
    expect(acceptWorkerStatus("failed")).toBe("failed");
    expect(acceptWorkerStatus("attention")).toBe("attention");

    // @ts-expect-error accepted must not become a top-level WorkerStatus
    acceptWorkerStatus("accepted");
    // @ts-expect-error verifying must remain evidence/review detail, not WorkerStatus
    acceptWorkerStatus("verifying");
    // @ts-expect-error remediating must remain remediation detail, not WorkerStatus
    acceptWorkerStatus("remediating");
    // @ts-expect-error crashed must normalize into failed/attention with error detail
    acceptWorkerStatus("crashed");
    // @ts-expect-error reassigned must remain orchestration detail, not WorkerStatus
    acceptWorkerStatus("reassigned");
    // @ts-expect-error blocked must remain beadwork issue state, not WorkerStatus
    acceptWorkerStatus("blocked");
  });

  it("makes worktreePath a type-level impossible state for current-branch workers", () => {
    // WHY: the type system should catch accidental worktree assumptions before runtime;
    // current-branch workers have checkoutPath/launchHead, not a disposable worktreePath.
    const worker = currentBranchWorker();

    // @ts-expect-error current-branch workers must not expose worktreePath
    expect(worker.worktreePath).toBeUndefined();
  });

  it("does not require IPC or lock files to prepare multiple current-branch workers", async () => {
    // WHY: Phase 1 current-branch preparation should stay a pure repo-identity probe;
    // adding flock/IPC/lease prerequisites would create a second scheduler beside beadwork.
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-nolocks-"));
    const lockRoot = path.join(repoRoot, ".pi", "beadwork", "locks");
    const { calls, runner } = createCurrentBranchRunner({ head: "shared-head" });

    const [first, second] = await Promise.all([
      prepareWorkerCheckout({
        config: currentBranchConfig(),
        ticketId: "BW-104",
        repoRoot,
        processRunner: runner,
      }),
      prepareWorkerCheckout({
        config: currentBranchConfig(),
        ticketId: "BW-105",
        repoRoot,
        processRunner: runner,
      }),
    ]);

    expect(first).toMatchObject({ executionMode: "current-branch", launchHead: "shared-head" });
    expect(second).toMatchObject({ executionMode: "current-branch", launchHead: "shared-head" });
    expect(existsSync(lockRoot)).toBe(false);
    expect(calls).toHaveLength(4);
    expect(calls.some((call) => /\b(flock|lock|lease|reservation|status)\b/.test(call))).toBe(
      false,
    );
  });

  it("keeps landing review config isolated from current-branch worker review config", async () => {
    // WHY: worktree landing review and current-branch worker review answer different
    // questions. Enabling or disabling one must not silently decide whether the other runs.
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-review-config-"));
    await writeProjectConfig(repoRoot, {
      landing: {
        review: {
          enabled: false,
        },
      },
      workerExecution: {
        review: {
          enabled: true,
        },
      },
    });

    const projectConfig = loadConfig(repoRoot);
    expect(projectConfig.landing.review.enabled).toBe(false);
    expect(projectConfig.workerExecution.review.enabled).toBe(true);

    process.env.PI_BEADWORK_REVIEW_ENABLED = "true";
    process.env.PI_BEADWORK_WORKER_REVIEW_ENABLED = "false";

    const envConfig = loadConfig(repoRoot);
    expect(envConfig.landing.review.enabled).toBe(true);
    expect(envConfig.workerExecution.review.enabled).toBe(false);
  });
});
