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
  requestWorkerLanding,
  runBoundedEpicLoop,
  stopWorkers,
} from "../../orchestrator.js";
import { ProcessCommandError } from "../../process.js";
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
