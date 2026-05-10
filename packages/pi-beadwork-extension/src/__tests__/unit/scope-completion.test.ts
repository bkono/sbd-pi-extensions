import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BeadworkAdapter } from "../../bw.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import { launchTicketWorker, runBoundedEpicLoop } from "../../orchestrator.js";
import {
  loadWorkerRegistry,
  resolveWorkerRegistryPath,
  saveWorkerRegistry,
} from "../../registry.js";
import type { TmuxBackend } from "../../tmux.js";
import type { BeadworkIssue, BeadworkIssueDetail, WorkerRuntime } from "../../types.js";

function createIssue(overrides: Partial<BeadworkIssueDetail> = {}): BeadworkIssueDetail {
  return {
    id: "BW-100",
    title: "Scope",
    description: "Deliver the complete Phase 4 scope.",
    status: "closed",
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

function createAdapter(overrides: Partial<BeadworkAdapter> = {}): BeadworkAdapter {
  return {
    prime: vi.fn(),
    ready: vi.fn().mockResolvedValue([]),
    blocked: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
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
    ticketStatus: "closed",
    executionMode: "current-branch",
    checkoutPath: "/tmp/repo",
    branchName: "main",
    launchHead: "base-sha",
    backend: "tmux",
    tmuxSession: "pi-bw",
    tmuxWindow: "bw-101-worker",
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
    status: "verified",
    validationStatus: "passed",
    landingVerifiedAt: "2026-04-14T00:10:00.000Z",
    landingVerification: "Current-branch worker verified.",
    commitShas: ["abc123"],
    touchedPaths: ["src/task.ts"],
    startedAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:10:00.000Z",
    ...overrides,
  };
}

async function createRuntimeWorker(
  repoRoot: string,
  overrides: Partial<WorkerRuntime> = {},
): Promise<WorkerRuntime> {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-scope-worker-"));
  await mkdir(runtimeDir, { recursive: true });
  const worker = createWorker({
    checkoutPath: repoRoot,
    runtimeDir,
    promptFile: path.join(runtimeDir, "handoff.txt"),
    scriptFile: path.join(runtimeDir, "launch.sh"),
    logFile: path.join(runtimeDir, "worker.log"),
    stateFile: path.join(runtimeDir, "state.txt"),
    exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
    finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
    ...overrides,
  });
  await Promise.all([
    writeFile(worker.promptFile, "prompt\n", "utf8"),
    writeFile(worker.scriptFile, "#!/bin/sh\n", "utf8"),
    writeFile(worker.logFile, "log\n", "utf8"),
    writeFile(worker.stateFile, `${worker.status}\n`, "utf8"),
    writeFile(worker.exitCodeFile, "0\n", "utf8"),
    writeFile(worker.finishedAtFile, "2026-04-14T00:10:00.000Z\n", "utf8"),
  ]);
  return worker;
}

function currentBranchConfig() {
  return {
    ...DEFAULT_CONFIG,
    workerExecution: {
      ...DEFAULT_CONFIG.workerExecution,
      mode: "current-branch" as const,
      review: { enabled: false },
    },
    landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
  };
}

function worktreeConfig() {
  return {
    ...DEFAULT_CONFIG,
    workerExecution: { ...DEFAULT_CONFIG.workerExecution, mode: "worktree" as const },
    landing: { ...DEFAULT_CONFIG.landing, validateCommands: ["echo scope-ok"] },
  };
}

function ok(stdout = "") {
  return { stdout, stderr: "", code: 0 };
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

function gitStatusRunner(statuses: string[] = [""]) {
  let statusIndex = 0;
  return (command: string, args: string[]) => {
    if (command === "git" && args[0] === "status") {
      const status = statuses[Math.min(statusIndex, statuses.length - 1)] ?? "";
      statusIndex += 1;
      return ok(status);
    }
    if (command === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
      return ok("main\n");
    }
    if (command === "git" && args[0] === "rev-parse") {
      return ok("abc123\n");
    }
    if (command === "git" && args[0] === "merge-base") {
      return ok("");
    }
    if (command === "git" && (args[0] === "diff" || args[0] === "log")) {
      return ok(args[0] === "log" ? "abc123 Implement task\n" : "");
    }
    if (command === "git" && args[0] === "show" && args.includes("--name-only")) {
      return ok("src/task.ts\n");
    }
    if (command === "git" && args[0] === "show") {
      return ok("Implement task\n");
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

function extractPromptPath(command: string): string | undefined {
  return command.match(/\$\(cat '([^']+)'\)/)?.[1] ?? command.match(/\$\(cat ([^)]+)\)/)?.[1];
}

type ScopeRunnerOptions = {
  statuses?: string[];
  validationResults?: Array<
    ReturnType<typeof ok> | { stdout: string; stderr: string; code: number }
  >;
  scopeReviewResults?: unknown[];
  dirtyDecision?: unknown;
  validationFailureDecision?: unknown;
  events?: string[];
};

function createScopeRunner(options: ScopeRunnerOptions = {}) {
  const git = gitStatusRunner(options.statuses ?? [""]);
  let validationIndex = 0;
  let scopeReviewIndex = 0;
  return vi.fn(async (command: string, args: string[]) => {
    if (command === "bash" && args[0] === "-lc" && args[1] === "echo scope-ok") {
      options.events?.push("validation");
      const result = options.validationResults?.[validationIndex] ?? ok("scope-ok\n");
      validationIndex += 1;
      return result;
    }
    if (command === "bash" && args[0] === "-lc" && args[1]?.includes("$(cat ")) {
      const promptPath = extractPromptPath(args[1]);
      const prompt = promptPath ? await readFile(promptPath, "utf8") : "";
      if (prompt.includes("Integrated scope validation failed")) {
        options.events?.push("validation-failure-review");
        return ok(
          JSON.stringify(
            options.validationFailureDecision ?? {
              classification: "attention",
              rationale: "ambiguous failure",
              safetyNotes: "operator review required",
            },
          ),
        );
      }
      if (prompt.includes("You are a scope-complete reviewer")) {
        options.events?.push("scope-review");
        const review = options.scopeReviewResults?.[scopeReviewIndex] ?? {
          summary: "scope complete",
          findings: [],
        };
        scopeReviewIndex += 1;
        return ok(JSON.stringify(review));
      }
      if (prompt.includes("quiescent dirty-state remediation")) {
        options.events?.push("dirty-review");
        return ok(JSON.stringify(options.dirtyDecision ?? { decisions: [] }));
      }
      throw new Error("unexpected reviewer prompt");
    }
    return git(command, args);
  });
}

async function runScopeCompletionScenario(input: {
  worker?: WorkerRuntime;
  issue?: BeadworkIssueDetail;
  adapter?: BeadworkAdapter;
  runner?: ReturnType<typeof vi.fn>;
  maxCycles?: number;
  config?: ReturnType<typeof currentBranchConfig> | ReturnType<typeof worktreeConfig>;
}) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-scope-completion-"));
  const registryPath = resolveWorkerRegistryPath(
    repoRoot,
    DEFAULT_CONFIG.storage.workerRegistryFile,
  );
  await saveWorkerRegistry(registryPath, [
    input.worker ?? createWorker({ checkoutPath: repoRoot }),
  ]);
  const child = createIssue({ id: "BW-101", type: "task", title: "Task", status: "closed" });
  const issue =
    input.issue ??
    createIssue({ id: "BW-100", status: "closed", children: [stripChildren(child)] });
  const adapter =
    input.adapter ??
    createAdapter({
      show: vi.fn(async (_cwd: string, id: string) => (id === issue.id ? issue : child)),
    });
  const summary = await runBoundedEpicLoop({
    cwd: repoRoot,
    repoRoot,
    config: input.config ?? currentBranchConfig(),
    adapter,
    epicId: issue.id,
    runner: input.runner ?? createScopeRunner(),
    tmuxBackend: createMockTmuxBackend(),
    options: {
      workers: 1,
      until: "blocked",
      dryRun: false,
      maxCycles: input.maxCycles ?? 1,
      pollIntervalMs: 0,
      noSpawn: false,
    },
  });
  return { summary, adapter, registryPath, repoRoot };
}

describe("Phase 4 scope-completion contract", () => {
  it("1. /bw run never completes a closed scope while workers are active", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-active-contract-"));
    const activeWorker = await createRuntimeWorker(repoRoot, { status: "running" });
    const runner = createScopeRunner();

    const { summary } = await runScopeCompletionScenario({ worker: activeWorker, runner });

    expect(summary.stopReason).toBe("max-cycles");
    expect(summary.workerSummary.active).toBe(1);
    expect(runner).not.toHaveBeenCalledWith("bash", ["-lc", "echo scope-ok"], expect.anything());
  });

  it("2. inline-verifies exited current-branch workers before scope completion", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-exited-contract-"));
    const worker = await createRuntimeWorker(repoRoot, {
      status: "exited",
      validationStatus: undefined,
      landingVerifiedAt: undefined,
      landingVerification: undefined,
    });
    const events: string[] = [];
    const runner = createScopeRunner({ events });

    const { summary, registryPath } = await runScopeCompletionScenario({ worker, runner });

    expect(summary.stopReason).toBe("completed");
    expect(events).toEqual(["validation", "scope-review"]);
    expect((await loadWorkerRegistry(registryPath))[0]).toMatchObject({ status: "verified" });
  });

  it("3. unresolved scope-review fix findings keep the scope from completing", async () => {
    const createIssueMock = vi.fn(async (_cwd, input) => ({
      issue: createIssue({ id: "BW-FIX-1", title: input.title, description: input.description }),
    }));
    const runner = createScopeRunner({
      scopeReviewResults: [
        {
          summary: "needs fix",
          findings: [
            { file: "src/task.ts", issue: "Incomplete", suggestion: "Fix it", severity: "fix" },
          ],
        },
      ],
    });

    const { summary } = await runScopeCompletionScenario({
      adapter: createAdapter({
        show: vi.fn(async (_cwd, id) =>
          id === "BW-100"
            ? createIssue({
                id: "BW-100",
                children: [createIssue({ id: "BW-101", status: "closed" })],
              })
            : createIssue({ id: "BW-101", status: "closed", type: "task" }),
        ),
        createIssue: createIssueMock,
      }),
      runner,
    });

    expect(summary.stopReason).toBe("max-cycles");
    expect(createIssueMock).toHaveBeenCalledTimes(1);
  });

  it("4. scope-complete validation runs exactly once when an epic first reaches quiescence", async () => {
    const runner = createScopeRunner();

    const { summary } = await runScopeCompletionScenario({ runner });

    expect(summary.stopReason).toBe("completed");
    expect(
      runner.mock.calls.filter((call) => call[0] === "bash" && call[1][1] === "echo scope-ok"),
    ).toHaveLength(1);
  });

  it("5. scope-level fix findings create fix-forward beadwork work", async () => {
    const createIssueMock = vi.fn(async (_cwd, input) => ({
      issue: createIssue({ id: "BW-FIX-1", title: input.title, description: input.description }),
    }));

    await runScopeCompletionScenario({
      adapter: createAdapter({
        show: vi.fn(async (_cwd, id) =>
          id === "BW-100"
            ? createIssue({
                id: "BW-100",
                children: [createIssue({ id: "BW-101", status: "closed" })],
              })
            : createIssue({ id: "BW-101", status: "closed", type: "task" }),
        ),
        createIssue: createIssueMock,
      }),
      runner: createScopeRunner({
        scopeReviewResults: [
          {
            summary: "needs fix",
            findings: [
              {
                file: "src/task.ts",
                issue: "End-to-end behavior is incomplete",
                suggestion: "Repair integration",
                severity: "fix",
              },
            ],
          },
        ],
      }),
    });

    expect(createIssueMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ parentId: "BW-100", priority: 1 }),
    );
    expect(createIssueMock.mock.calls[0]?.[1].description).toContain(
      "scope-review-finding-signature:",
    );
  });

  it("6. scope-level findings do not mutate already-verified worker records", async () => {
    const worker = createWorker({ status: "verified", reviewStatus: "approved" });

    const { registryPath } = await runScopeCompletionScenario({
      worker,
      runner: createScopeRunner({
        scopeReviewResults: [
          {
            summary: "docs follow-up",
            findings: [{ file: "docs/task.md", issue: "Document it", severity: "nit" }],
          },
        ],
      }),
    });

    expect((await loadWorkerRegistry(registryPath))[0]).toMatchObject({
      status: "verified",
      reviewStatus: "approved",
    });
  });

  it("7. quiescent dirty-state remediation runs before validation", async () => {
    const events: string[] = [];
    const runner = createScopeRunner({
      statuses: ["?? dist/cache.tmp\n", ""],
      dirtyDecision: {
        decisions: [
          {
            path: "dist/cache.tmp",
            classification: "generated-artifact",
            rationale: "build output",
            action: { type: "delete", paths: ["dist/cache.tmp"] },
          },
        ],
      },
      events,
    });

    const { repoRoot, summary } = await runScopeCompletionScenario({ runner });

    expect(summary.stopReason).toBe("completed");
    expect(events.indexOf("dirty-review")).toBeLessThan(events.indexOf("validation"));
    expect(existsSync(path.join(repoRoot, "dist", "cache.tmp"))).toBe(false);
  });

  it("8. dirty-state remediation never runs while workers are active", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-active-dirty-contract-"));
    const events: string[] = [];
    const worker = await createRuntimeWorker(repoRoot, { status: "running" });

    await runScopeCompletionScenario({
      worker,
      runner: createScopeRunner({ statuses: ["?? dist/cache.tmp\n"], events }),
    });

    expect(events).not.toContain("dirty-review");
    expect(events).not.toContain("validation");
  });

  it("9. standalone /bw delegate ticket is tracked as its own validation scope", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-standalone-delegate-"));
    const ticket = createIssue({ id: "BW-201", type: "task", parentId: "BW-200" });
    const parent = createIssue({ id: "BW-200", type: "epic" });
    const adapter = createAdapter({
      show: vi.fn(async (_cwd, id) => (id === "BW-201" ? ticket : parent)),
    });

    const worker = await launchTicketWorker({
      cwd: repoRoot,
      repoRoot,
      config: currentBranchConfig(),
      adapter,
      ticketId: ticket.id,
      tmuxBackend: createMockTmuxBackend(),
      processRunner: vi.fn(async (command: string, args: string[]) =>
        gitStatusRunner()(command, args),
      ),
    });

    expect(worker.epicId).toBe("BW-201");
  });

  it("10. standalone ticket scope validates once and skips epic-only scope review", async () => {
    const taskScope = createIssue({ id: "BW-201", type: "task", status: "closed", children: [] });
    const runner = createScopeRunner();

    const { summary } = await runScopeCompletionScenario({
      worker: createWorker({ epicId: "BW-201", ticketId: "BW-201" }),
      issue: taskScope,
      adapter: createAdapter({ show: vi.fn(async () => taskScope) }),
      runner,
    });

    expect(summary.stopReason).toBe("completed");
    expect(
      runner.mock.calls.filter((call) => call[0] === "bash" && call[1][1] === "echo scope-ok"),
    ).toHaveLength(1);
    expect(
      runner.mock.calls.filter((call) => call[0] === "bash" && call[1][1]?.includes("$(cat ")),
    ).toHaveLength(0);
  });

  it("11. scope-level fix iterations are capped at two rounds", async () => {
    const existingIssues = [
      createIssue({
        id: "BW-FIX-1",
        parentId: "BW-100",
        description: "scope-review-fix-round: 1\nscope-review-finding-signature: one",
      }),
      createIssue({
        id: "BW-FIX-2",
        parentId: "BW-100",
        description: "scope-review-fix-round: 2\nscope-review-finding-signature: two",
      }),
    ];
    const createIssueMock = vi.fn();

    const { summary } = await runScopeCompletionScenario({
      adapter: createAdapter({
        show: vi.fn(async (_cwd, id) =>
          id === "BW-100"
            ? createIssue({
                id: "BW-100",
                children: [createIssue({ id: "BW-101", status: "closed" })],
              })
            : createIssue({ id: "BW-101", status: "closed", type: "task" }),
        ),
        list: vi.fn(async () => existingIssues),
        createIssue: createIssueMock,
      }),
      runner: createScopeRunner({
        scopeReviewResults: [
          {
            summary: "still broken",
            findings: [{ file: "src/task.ts", issue: "Incomplete", severity: "fix" }],
          },
        ],
      }),
    });

    expect(summary.stopReason).toBe("attention");
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("12. non-convergence after two fix-forward rounds routes to attention", async () => {
    const { summary } = await runScopeCompletionScenario({
      adapter: createAdapter({
        show: vi.fn(async (_cwd, id) =>
          id === "BW-100"
            ? createIssue({
                id: "BW-100",
                children: [createIssue({ id: "BW-101", status: "closed" })],
              })
            : createIssue({ id: "BW-101", status: "closed", type: "task" }),
        ),
        list: vi.fn(async () => [
          createIssue({
            id: "BW-FIX-1",
            parentId: "BW-100",
            description: "scope-review-fix-round: 1\nscope-review-classification: fix",
          }),
          createIssue({
            id: "BW-FIX-2",
            parentId: "BW-100",
            description: "scope-review-fix-round: 2\nscope-review-classification: fix",
          }),
        ]),
      }),
      runner: createScopeRunner({
        scopeReviewResults: [
          {
            summary: "still broken",
            findings: [
              {
                file: "src/task.ts",
                issue: "Incomplete",
                suggestion: "Fix it",
                severity: "fix",
              },
            ],
          },
        ],
      }),
    });

    expect(summary.stopReason).toBe("attention");
    expect(summary.notes.join("\n")).toContain("exceeded 2 fix-forward rounds");
  });

  it("13. scope validation failure creates attributed fix-forward work instead of mutating workers", async () => {
    const createIssueMock = vi.fn(async (_cwd, input) => ({
      issue: createIssue({
        id: "BW-VAL-FIX-1",
        title: input.title,
        description: input.description,
      }),
    }));
    const runner = createScopeRunner({
      validationResults: [
        { stdout: "FAIL src/task.test.ts\n", stderr: "expected behavior\n", code: 1 },
      ],
      validationFailureDecision: {
        classification: "create-fix-forward",
        rationale: "Maps to BW-101 and abc123.",
        safetyNotes: "Create child task only.",
        suspectedTickets: ["BW-101"],
        suspectedCommits: ["abc123"],
        files: ["src/task.ts"],
        tests: ["src/task.test.ts"],
        title: "Repair integrated behavior",
        successCriteria: ["echo scope-ok passes"],
      },
    });

    const { summary, registryPath } = await runScopeCompletionScenario({
      adapter: createAdapter({
        show: vi.fn(async (_cwd, id) =>
          id === "BW-100"
            ? createIssue({
                id: "BW-100",
                children: [createIssue({ id: "BW-101", status: "closed" })],
              })
            : createIssue({ id: "BW-101", status: "closed", type: "task" }),
        ),
        createIssue: createIssueMock,
      }),
      runner,
    });

    expect(summary.stopReason).toBe("max-cycles");
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ parentId: "BW-100", priority: 1 }),
    );
    expect((await loadWorkerRegistry(registryPath))[0]).toMatchObject({ status: "verified" });
  });

  it("14. clean quiescence validates, reviews, and completes end-to-end", async () => {
    const events: string[] = [];

    const { summary } = await runScopeCompletionScenario({ runner: createScopeRunner({ events }) });

    expect(summary.stopReason).toBe("completed");
    expect(events).toEqual(["validation", "scope-review"]);
    expect(summary.notes.join("\n")).toContain("Scope review:");
  });

  it("15. worktree mode preserves the landed-worker completion path without scope review", async () => {
    const runner = createScopeRunner();
    const { summary } = await runScopeCompletionScenario({
      worker: {
        ...createWorker({ status: "landed", validationStatus: "passed" }),
        executionMode: "worktree",
        worktreePath: "/tmp/worktree",
        checkoutPath: "/tmp/worktree",
      },
      config: worktreeConfig(),
      runner,
    });

    expect(summary.stopReason).toBe("completed");
    expect(summary.workerSummary.landed).toBe(1);
    expect(
      runner.mock.calls.filter((call) => call[0] === "bash" && call[1][1]?.includes("$(cat ")),
    ).toHaveLength(0);
  });
});
