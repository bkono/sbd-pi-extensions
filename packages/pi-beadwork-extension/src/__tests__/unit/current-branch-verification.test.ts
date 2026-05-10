import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildAttributionEvidencePack } from "../../attribution.js";
import type { BeadworkAdapter } from "../../bw.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import {
  type CurrentBranchVerificationPipeline,
  inspectWorkerRuntime,
  verifyCurrentBranchWorker,
} from "../../orchestrator.js";
import type { ProcessResult, ProcessRunner } from "../../process.js";
import type { TmuxBackend } from "../../tmux.js";
import type {
  BeadworkHistoryEntry,
  BeadworkIssueDetail,
  CurrentBranchWorkerRuntime,
  ReviewFinding,
  ReviewTriageDecision,
  WorktreeWorkerRuntime,
} from "../../types.js";

type CommitSpec = {
  sha: string;
  subject: string;
  paths?: string[];
  ancestor?: boolean;
};

type RunnerOptions = {
  branch?: string;
  head?: string;
  launchAncestor?: boolean;
  strongCommits?: CommitSpec[];
  contextCommits?: CommitSpec[];
  reviewOutput?: string;
  failGit?: Record<string, ProcessResult>;
};

function issue(overrides: Partial<BeadworkIssueDetail> = {}): BeadworkIssueDetail {
  return {
    id: "BW-101",
    title: "Current branch verification",
    description: "Implement current-branch verification safely.",
    status: "closed",
    type: "task",
    priority: 1,
    labels: [],
    blockedBy: [],
    blocks: [],
    assignee: "",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T01:00:00.000Z",
    parentId: "BW-100",
    children: [],
    ...overrides,
  };
}

function adapter(
  input: { issues?: BeadworkIssueDetail[]; history?: BeadworkHistoryEntry[] } = {},
): BeadworkAdapter {
  const issues = new Map<string, BeadworkIssueDetail>();
  for (const item of [
    issue(),
    issue({ id: "BW-100", title: "Epic", type: "epic" }),
    ...(input.issues ?? []),
  ]) {
    issues.set(item.id, item);
  }

  return {
    prime: vi.fn(),
    ready: vi.fn(),
    blocked: vi.fn(),
    list: vi.fn(),
    show: vi.fn(async (_cwd: string, id: string) => {
      const found = issues.get(id);
      if (!found) {
        throw new Error(`missing issue ${id}`);
      }
      return found;
    }),
    history: vi.fn(async () => input.history ?? []),
    createIssue: vi.fn(async (_cwd, createInput) => ({
      issue: issue({
        id: `${createInput.parentId ?? "BW-100"}.follow-up`,
        title: createInput.title,
        description: createInput.description ?? "",
        status: "open",
        type: createInput.type ?? "task",
        parentId: createInput.parentId,
      }),
    })),
    updateIssue: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    comment: vi.fn(async (_cwd: string, id: string) => issues.get(id) ?? issue({ id })),
    label: vi.fn(),
    start: vi.fn(),
    close: vi.fn(async (_cwd: string, id: string) => ({
      ...(issues.get(id) ?? issue({ id })),
      status: "closed",
    })),
    reopen: vi.fn(async (_cwd: string, id: string) => ({
      ...(issues.get(id) ?? issue({ id })),
      status: "open",
    })),
    defer: vi.fn(),
    undefer: vi.fn(),
    sync: vi.fn(),
    getCounts: vi.fn(),
  } as BeadworkAdapter;
}

function ok(stdout = ""): ProcessResult {
  return { stdout, stderr: "", code: 0 };
}

function fail(stderr = "failed"): ProcessResult {
  return { stdout: "", stderr, code: 1 };
}

function makeRunner(options: RunnerOptions = {}): ProcessRunner {
  const branch = options.branch ?? "main";
  const head = options.head ?? "head-sha";
  const strongCommits = options.strongCommits ?? [
    { sha: "aaaaaaa", subject: "BW-101 implement task", paths: ["src/task.ts"] },
  ];
  const contextCommits = options.contextCommits ?? strongCommits;
  const commits = [...strongCommits, ...contextCommits];
  const result = vi.fn(async (command: string, args: string[], runnerOptions = {}) => {
    if (command === "bash" && args[1]?.includes("current-branch-review-handoff")) {
      runnerOptions.onStdoutChunk?.("review stdout chunk\n");
      runnerOptions.onStderrChunk?.("review stderr chunk\n");
      return ok(
        options.reviewOutput ??
          '<review_report>{"summary":"approved","findings":[]}</review_report>',
      );
    }
    if (command !== "git") {
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    }

    const key = args.join(" ");
    if (options.failGit?.[key]) {
      return options.failGit[key];
    }
    if (key === "rev-parse --abbrev-ref HEAD") {
      return ok(`${branch}\n`);
    }
    if (key === "rev-parse HEAD") {
      return ok(`${head}\n`);
    }
    if (key === "merge-base --is-ancestor launch-head HEAD") {
      return options.launchAncestor === false ? fail("launch head missing") : ok();
    }
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      const sha = args[2] ?? "";
      const commit = commits.find((item) => item.sha === sha);
      return commit?.ancestor === false ? fail("commit missing") : ok();
    }
    if (args[0] === "log" && args.includes("--grep=BW-101")) {
      return ok(strongCommits.map((item) => `${item.sha}\t${item.subject}`).join("\n"));
    }
    if (args[0] === "log") {
      return ok(contextCommits.map((item) => `${item.sha}\t${item.subject}`).join("\n"));
    }
    if (args[0] === "show" && args[1] === "--name-only") {
      const sha = args[args.length - 1] ?? "";
      const commit = commits.find((item) => item.sha === sha);
      return ok(`${(commit?.paths ?? []).join("\n")}\n`);
    }
    if (args[0] === "show" && args[1] === "-s") {
      const sha = args[args.length - 1] ?? "";
      const commit = commits.find((item) => item.sha === sha);
      return ok(`${commit?.subject ?? "subject unavailable"}\n`);
    }
    return ok();
  });
  return result;
}

function tmux(): TmuxBackend {
  return {
    ensureSession: vi.fn(async () => ({ sessionName: "pi-bw", created: false })),
    launchWorker: vi.fn(async (input) => ({
      sessionName: input.sessionName,
      windowName: `${input.workerId}-window`,
      paneId: "%99",
      launchCommand: input.launchCommand,
    })),
    inspectWorker: vi.fn(async () => ({ exists: false })),
    cleanupWorker: vi.fn(async () => undefined),
  };
}

function config(reviewEnabled = false) {
  return {
    ...DEFAULT_CONFIG,
    workerExecution: {
      ...DEFAULT_CONFIG.workerExecution,
      mode: "current-branch" as const,
      review: { enabled: reviewEnabled },
    },
  };
}

async function currentWorker(
  repoRoot: string,
  overrides: Partial<CurrentBranchWorkerRuntime> = {},
): Promise<CurrentBranchWorkerRuntime> {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-current-verification-"));
  const worker: CurrentBranchWorkerRuntime = {
    workerId: overrides.workerId ?? "bw-101-worker",
    ticketId: overrides.ticketId ?? "BW-101",
    epicId: overrides.epicId ?? "BW-100",
    ticketTitle: overrides.ticketTitle ?? "Current branch verification",
    ticketStatus: overrides.ticketStatus ?? "closed",
    backend: "tmux",
    tmuxSession: "pi-bw",
    tmuxWindow: "bw-101",
    tmuxPane: "%42",
    runtimeDir,
    promptFile: path.join(runtimeDir, "handoff.txt"),
    scriptFile: path.join(runtimeDir, "launch.sh"),
    logFile: path.join(runtimeDir, "worker.log"),
    stateFile: path.join(runtimeDir, "state.txt"),
    exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
    finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
    launchCommand: `bash ${path.join(runtimeDir, "launch.sh")}`,
    workerCommand: "pi --mode json",
    executionMode: "current-branch",
    checkoutPath: repoRoot,
    branchName: "main",
    launchHead: "launch-head",
    status: "exited",
    startedAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T01:00:00.000Z",
    finishedAt: "2026-05-08T01:00:00.000Z",
    ...overrides,
  };
  await mkdir(runtimeDir, { recursive: true });
  await Promise.all([
    writeFile(worker.promptFile, "original handoff\n", "utf8"),
    writeFile(worker.scriptFile, "#!/bin/sh\n", "utf8"),
    writeFile(worker.logFile, "worker log\n", "utf8"),
    writeFile(worker.stateFile, "exited\n", "utf8"),
    writeFile(worker.exitCodeFile, "0\n", "utf8"),
    writeFile(worker.finishedAtFile, "2026-05-08T01:00:00.000Z\n", "utf8"),
  ]);
  return worker;
}

async function worktreeWorker(repoRoot: string): Promise<WorktreeWorkerRuntime> {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-worktree-verification-"));
  return {
    workerId: "bw-102-worker",
    ticketId: "BW-102",
    epicId: "BW-100",
    ticketTitle: "Worktree ticket",
    ticketStatus: "closed",
    backend: "tmux",
    tmuxSession: "pi-bw",
    tmuxWindow: "bw-102",
    tmuxPane: "%43",
    runtimeDir,
    promptFile: path.join(runtimeDir, "handoff.txt"),
    scriptFile: path.join(runtimeDir, "launch.sh"),
    logFile: path.join(runtimeDir, "worker.log"),
    stateFile: path.join(runtimeDir, "state.txt"),
    exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
    finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
    launchCommand: `bash ${path.join(runtimeDir, "launch.sh")}`,
    workerCommand: "pi --mode json",
    executionMode: "worktree",
    checkoutPath: path.join(repoRoot, "../worktree"),
    worktreePath: path.join(repoRoot, "../worktree"),
    branchName: "BW-102/worktree-ticket",
    status: "landed",
    landingVerification: "Worktree branch landed successfully.",
    validationStatus: "passed",
    startedAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T01:00:00.000Z",
  };
}

async function repo(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pi-bw-current-repo-"));
}

function fixFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    file: "src/task.ts",
    issue: "regression breaks current-branch verification",
    suggestion: "fix the regression",
    severity: "fix",
    ...overrides,
  };
}

function findingKey(finding: ReviewFinding): string {
  return [finding.severity, finding.file, finding.issue, finding.suggestion]
    .map((value) => value.trim().toLowerCase())
    .join("|");
}

async function verify(input: {
  worker: CurrentBranchWorkerRuntime;
  runner?: ProcessRunner;
  adapter?: BeadworkAdapter;
  tmuxBackend?: TmuxBackend;
  reviewEnabled?: boolean;
  pipeline?: CurrentBranchVerificationPipeline;
}) {
  return verifyCurrentBranchWorker({
    cwd: input.worker.checkoutPath,
    repoRoot: input.worker.checkoutPath,
    worker: input.worker,
    config: config(input.reviewEnabled),
    adapter: input.adapter ?? adapter(),
    tmuxBackend: input.tmuxBackend ?? tmux(),
    runner: input.runner ?? makeRunner(),
    pipeline: input.pipeline,
  });
}

describe("current-branch verification regression contract", () => {
  it("1. routes closed current-branch completions to verification instead of worktree landing", async () => {
    const repoRoot = await repo();
    const worker = await currentWorker(repoRoot);
    const runner = makeRunner();
    const lifecycleEvents: string[] = [];

    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker,
      adapter: adapter(),
      config: config(false),
      tmuxBackend: tmux(),
      runner,
      onLifecycleEvent: (event) => lifecycleEvents.push(event.message),
    });

    expect(inspected.status).toBe("verified");
    expect(inspected.executionMode).toBe("current-branch");
    expect(inspected.landingVerification).toContain("Current-branch worker verified");
    expect(lifecycleEvents).toContain(
      "Delegated ticket BW-101 [current-branch] exited closed. Starting current-branch verification.",
    );
  });

  it("1b. standalone current-branch delegate verification does not run scope-complete review", async () => {
    const repoRoot = await repo();
    const runner = makeRunner({
      reviewOutput: '<review_report>{"summary":"approved","findings":[]}</review_report>',
    });

    const inspected = await verify({
      worker: await currentWorker(repoRoot),
      runner,
      reviewEnabled: true,
    });

    const bashCommands = vi
      .mocked(runner)
      .mock.calls.filter((call) => call[0] === "bash")
      .map((call) => call[1].join(" "));
    expect(inspected.status).toBe("verified");
    expect(bashCommands).toHaveLength(1);
    expect(bashCommands[0]).toContain("current-branch-review-handoff");
    expect(bashCommands[0]).not.toContain("scope-complete");
    expect(bashCommands[0]).not.toContain("scope-review");
  });

  it("2. skips rebase, merge-back, containment, and worktree cleanup steps", async () => {
    const repoRoot = await repo();
    const cleanupAwareTmux = tmux();
    const runner = makeRunner();

    const inspected = await verify({
      worker: await currentWorker(repoRoot),
      runner,
      tmuxBackend: cleanupAwareTmux,
    });

    const gitCommands = vi.mocked(runner).mock.calls.map((call) => call[1].join(" "));
    expect(inspected.status).toBe("verified");
    expect(
      gitCommands.some((command) =>
        ["rebase", "merge", "worktree", "status", "diff"].includes(command.split(" ")[0] ?? ""),
      ),
    ).toBe(false);
    expect(cleanupAwareTmux.cleanupWorker).not.toHaveBeenCalled();
    expect(inspected.landingVerification).toContain("No worktree rebase, merge-back");
  });

  it("3. writes an attribution pack with every expected evidence section", async () => {
    const repoRoot = await repo();
    const worker = await currentWorker(repoRoot);
    const evidence = await buildAttributionEvidencePack({
      worker,
      adapter: adapter({
        issues: [
          issue({
            children: [issue({ id: "BW-101.1", title: "Child", parentId: "BW-101" })],
            blockedBy: ["BW-090"],
            blocks: ["BW-102"],
          }),
          issue({ id: "BW-090", title: "Blocker" }),
          issue({ id: "BW-102", title: "Follow-up" }),
        ],
        history: [{ intent: "comment", message: "Handoff: committed aaaaaaa" }],
      }),
      processRunner: makeRunner(),
    });

    for (const section of [
      "## Attention flags",
      "## Worker runtime and artifact pointers",
      "## Branch identity and ancestry checks",
      "## Ticket context",
      "## Beadwork comments and history evidence",
      "## Worker handoff and validation evidence",
      "## Strong candidate commits after launchHead",
      "## Comment-mentioned or worker-claimed commits",
      "## Bounded post-launch commit context",
      "## Derived touched paths",
      "## Coordinator guidance",
    ]) {
      expect(evidence.renderedText).toContain(section);
    }
  });

  it("4. runs per-worker review for every closed completion when enabled", async () => {
    const repoRoot = await repo();
    const runner = makeRunner();

    await verify({
      worker: await currentWorker(repoRoot, { workerId: "worker-one" }),
      runner,
      reviewEnabled: true,
    });
    await verify({
      worker: await currentWorker(repoRoot, { workerId: "worker-two" }),
      runner,
      reviewEnabled: true,
    });

    expect(vi.mocked(runner).mock.calls.filter((call) => call[0] === "bash")).toHaveLength(2);
  });

  it("5. does not pass a truncated patch bundle to current-branch review", async () => {
    const repoRoot = await repo();
    const worker = await currentWorker(repoRoot);
    const runner = makeRunner();

    await verify({ worker, runner, reviewEnabled: true });

    const prompt = await readFile(
      path.join(worker.runtimeDir, "current-branch-review-handoff.txt"),
      "utf8",
    );
    const gitCommands = vi.mocked(runner).mock.calls.map((call) => call[1].join(" "));
    expect(prompt).not.toContain("Unified diff excerpt");
    expect(prompt).not.toContain("launch-head..HEAD");
    expect(gitCommands.some((command) => command.startsWith("diff "))).toBe(false);
  });

  it("6. centers review on ticket-attributed commits", async () => {
    const repoRoot = await repo();
    const worker = await currentWorker(repoRoot);

    await verify({ worker, reviewEnabled: true });

    const prompt = await readFile(
      path.join(worker.runtimeDir, "current-branch-review-handoff.txt"),
      "utf8",
    );
    expect(prompt).toContain("ticket-attributed commits on the current branch");
    expect(prompt).toContain("Attributed commit list to inspect with tools");
    expect(prompt).toContain("BW-101");
    expect(prompt).toContain("aaaaaaa");
    expect(prompt).toContain("git show");
  });

  it("7. coordinator triage classifies fix, file, and reject findings correctly", async () => {
    const repoRoot = await repo();
    const findings = [
      fixFinding(),
      fixFinding({
        issue: "style only follow-up",
        suggestion: "file a later polish task",
        severity: "nit",
      }),
      fixFinding({ issue: "false positive: already handled", suggestion: "discard it" }),
    ];

    const result = await verify({
      worker: await currentWorker(repoRoot, {
        reviewFindings: findings,
        reviewStatus: "changes-requested",
      }),
      tmuxBackend: tmux(),
    });

    expect(result.reviewTriageDecisions?.map((decision) => decision.classification)).toEqual([
      "fix",
      "file",
      "reject",
    ]);
  });

  it("8. fix findings relaunch remediation with only coordinator-approved fixes in the prompt", async () => {
    const repoRoot = await repo();
    const finding = fixFinding({ issue: "must fix before verification" });
    const backend = tmux();
    const result = await verify({
      worker: await currentWorker(repoRoot, {
        reviewFindings: [finding],
        reviewStatus: "changes-requested",
      }),
      tmuxBackend: backend,
    });

    expect(result.status).toBe("running");
    expect(result.reviewStatus).toBe("remediation-in-progress");
    expect(backend.launchWorker).toHaveBeenCalledTimes(1);
    await expect(readFile(result.promptFile, "utf8")).resolves.toContain(
      "Coordinator-approved fix findings",
    );
    await expect(readFile(result.promptFile, "utf8")).resolves.toContain(
      "must fix before verification",
    );
  });

  it("9. reopens/comments closed tickets for remediation and verifies once the worker re-closes", async () => {
    const repoRoot = await repo();
    const beadwork = adapter({ issues: [issue({ status: "closed" })] });
    const launched = await verify({
      worker: await currentWorker(repoRoot, {
        reviewFindings: [fixFinding()],
        reviewStatus: "changes-requested",
      }),
      adapter: beadwork,
      tmuxBackend: tmux(),
    });

    expect(beadwork.reopen).toHaveBeenCalledWith(repoRoot, "BW-101");
    expect(beadwork.comment).toHaveBeenCalledWith(
      repoRoot,
      "BW-101",
      expect.stringContaining("reopening this closed ticket"),
    );
    await expect(readFile(launched.promptFile, "utf8")).resolves.toContain("Close ticket BW-101");

    const verified = await verify({
      worker: await currentWorker(repoRoot, {
        ...launched,
        status: "exited",
        ticketStatus: "closed",
        reviewStatus: "remediation-in-progress",
      }),
      adapter: beadwork,
      runner: makeRunner({
        reviewOutput: '<review_report>{"summary":"fixed","findings":[]}</review_report>',
      }),
      reviewEnabled: true,
    });
    expect(verified.status).toBe("verified");
    expect(verified.ticketStatus).toBe("closed");
  });

  it("10. repeated polls do not duplicate an active remediation launch for the same findings", async () => {
    const repoRoot = await repo();
    const finding = fixFinding();
    const key = findingKey(finding);
    const backend = tmux();

    const result = await verify({
      worker: await currentWorker(repoRoot, {
        status: "running",
        reviewStatus: "remediation-in-progress",
        reviewRemediationAttempts: 1,
        reviewFindings: [finding],
        reviewTriageFindingSetKey: key,
        currentBranchRemediationFindingSetKey: key,
        reviewTriageDecisions: [
          {
            finding,
            findingKey: key,
            classification: "fix",
            rationale: "already approved",
            action: "approved for current-branch remediation",
          },
        ],
      }),
      tmuxBackend: backend,
    });

    expect(result.status).toBe("running");
    expect(result.reviewRemediationAttempts).toBe(1);
    expect(backend.launchWorker).not.toHaveBeenCalled();
  });

  it("11. file findings create non-blocking beadwork follow-up comments and do not block", async () => {
    const repoRoot = await repo();
    const beadwork = adapter();
    const result = await verify({
      worker: await currentWorker(repoRoot, {
        reviewFindings: [
          fixFinding({
            issue: "style only follow-up",
            suggestion: "rename this later",
            severity: "nit",
          }),
        ],
        reviewStatus: "changes-requested",
      }),
      adapter: beadwork,
    });

    expect(result.status).toBe("verified");
    expect(result.reviewTriageDecisions?.[0]?.classification).toBe("file");
    expect(beadwork.comment).toHaveBeenCalledWith(
      repoRoot,
      "BW-101",
      expect.stringContaining("non-blocking follow-up"),
    );
  });

  it("12. reject findings are discarded without relaunching or filing follow-up", async () => {
    const repoRoot = await repo();
    const beadwork = adapter();
    const backend = tmux();
    const result = await verify({
      worker: await currentWorker(repoRoot, {
        reviewFindings: [fixFinding({ issue: "false positive: already handled" })],
        reviewStatus: "changes-requested",
      }),
      adapter: beadwork,
      tmuxBackend: backend,
    });

    expect(result.status).toBe("verified");
    expect(result.reviewTriageDecisions?.[0]).toMatchObject({ classification: "reject" });
    expect(beadwork.comment).not.toHaveBeenCalled();
    expect(backend.launchWorker).not.toHaveBeenCalled();
  });

  it("13. enforces the current-branch remediation cap at two attempts", async () => {
    const repoRoot = await repo();
    const backend = tmux();
    const result = await verify({
      worker: await currentWorker(repoRoot, {
        reviewFindings: [fixFinding()],
        reviewStatus: "changes-requested",
        reviewRemediationAttempts: 2,
      }),
      tmuxBackend: backend,
    });

    expect(result.status).toBe("attention");
    expect(result.lastError).toContain("attempts exhausted (2/2)");
    expect(backend.launchWorker).not.toHaveBeenCalled();
  });

  it("14. missing attribution routes to attention", async () => {
    const repoRoot = await repo();
    const result = await verify({
      worker: await currentWorker(repoRoot),
      runner: makeRunner({ strongCommits: [], contextCommits: [] }),
      adapter: adapter({ history: [] }),
    });

    expect(result.status).toBe("attention");
    expect(result.lastError).toContain("no attributed commits");
  });

  it("15. accepts omitted ticket IDs when handoff evidence mentions the commit", async () => {
    const repoRoot = await repo();
    const result = await verify({
      worker: await currentWorker(repoRoot),
      runner: makeRunner({
        strongCommits: [],
        contextCommits: [{ sha: "bbbbbbb", subject: "implement helper", paths: ["src/helper.ts"] }],
      }),
      adapter: adapter({
        history: [{ intent: "comment", message: "Handoff: commit bbbbbbb for BW-101" }],
      }),
    });

    expect(result.status).toBe("verified");
    expect(result.commitShas).toEqual(["bbbbbbb"]);
    expect(result.touchedPaths).toEqual(["src/helper.ts"]);
  });

  it("16. detects branch drift and routes to attention", async () => {
    const repoRoot = await repo();
    const result = await verify({
      worker: await currentWorker(repoRoot, { branchName: "feature/original" }),
      runner: makeRunner({ branch: "feature/drifted" }),
    });

    expect(result.status).toBe("attention");
    expect(result.lastError).toContain("Branch drift detected");
  });

  it("17. supports explicit detached-HEAD launches without normal branch-drift assumptions", async () => {
    const repoRoot = await repo();
    const result = await verify({
      worker: await currentWorker(repoRoot, { branchName: "HEAD" }),
      runner: makeRunner({ branch: "HEAD" }),
    });

    expect(result.status).toBe("verified");
    expect(result.lastError).toBeUndefined();
    const evidence = await readFile(
      path.join(result.runtimeDir, "current-branch-attribution.md"),
      "utf8",
    );
    expect(evidence).toContain("detached HEAD launch: YES");
    expect(evidence).toContain("branch drift: no");
  });

  it("18. ancestry failures route to attention", async () => {
    const repoRoot = await repo();
    const result = await verify({
      worker: await currentWorker(repoRoot),
      runner: makeRunner({
        launchAncestor: false,
        strongCommits: [{ sha: "aaaaaaa", subject: "BW-101 implement", ancestor: false }],
      }),
    });

    expect(result.status).toBe("attention");
    expect(result.lastError).toContain("Launch head launch-head is not an ancestor");
    expect(result.lastError).toContain("Commit aaaaaaa is not an ancestor");
  });

  it("19. already verified workers return immediately on re-inspection", async () => {
    const repoRoot = await repo();
    const runner = makeRunner();
    const result = await verify({
      worker: await currentWorker(repoRoot, { status: "verified", landingVerifiedAt: "already" }),
      runner,
    });

    expect(result.status).toBe("verified");
    expect(vi.mocked(runner)).not.toHaveBeenCalled();
  });

  it("20. repeated verification after restart does not relaunch duplicate remediation", async () => {
    const repoRoot = await repo();
    const finding = fixFinding();
    const key = findingKey(finding);
    const decision: ReviewTriageDecision = {
      finding,
      findingKey: key,
      classification: "fix",
      rationale: "already approved",
      action: "approved for current-branch remediation",
    };
    const backend = tmux();

    const result = await verify({
      worker: await currentWorker(repoRoot, {
        status: "exited",
        reviewStatus: "remediation-in-progress",
        reviewFindings: [finding],
        reviewTriageFindingSetKey: key,
        currentBranchRemediationFindingSetKey: key,
        reviewTriageDecisions: [decision],
        reviewRemediationAttempts: 1,
      }),
      tmuxBackend: backend,
    });

    expect(result.status).toBe("running");
    expect(result.reviewRemediationAttempts).toBe(1);
    expect(backend.launchWorker).not.toHaveBeenCalled();
  });

  it("21. repeated verification does not duplicate follow-up beadwork comments", async () => {
    const repoRoot = await repo();
    const finding = fixFinding({ issue: "style only follow-up", severity: "nit" });
    const key = findingKey(finding);
    const beadwork = adapter();

    const result = await verify({
      worker: await currentWorker(repoRoot, {
        reviewStatus: "nits-only",
        reviewFindings: [finding],
        reviewTriageFindingSetKey: key,
        reviewTriageDecisions: [
          {
            finding,
            findingKey: key,
            classification: "file",
            rationale: "already filed",
            action: "filed non-blocking follow-up comment on ticket",
          },
        ],
      }),
      adapter: beadwork,
    });

    expect(result.status).toBe("verified");
    expect(beadwork.comment).not.toHaveBeenCalled();
  });

  it("22. leaves worktree-mode landing semantics unchanged", async () => {
    const repoRoot = await repo();
    const runner = makeRunner();
    const inspected = await inspectWorkerRuntime({
      cwd: repoRoot,
      repoRoot,
      worker: await worktreeWorker(repoRoot),
      adapter: adapter({ issues: [issue({ id: "BW-102", status: "closed" })] }),
      config: DEFAULT_CONFIG,
      tmuxBackend: tmux(),
      runner,
    });

    expect(inspected.executionMode).toBe("worktree");
    expect(inspected.status).toBe("landed");
    expect(inspected.landingVerification).toBe("Worktree branch landed successfully.");
    expect(vi.mocked(runner)).not.toHaveBeenCalledWith("git", expect.any(Array), expect.anything());
  });

  it("23. preserves diagnostics in logs and worker fields for review/triage/remediation", async () => {
    const repoRoot = await repo();
    const result = await verify({
      worker: await currentWorker(repoRoot, {
        reviewFindings: [fixFinding()],
        reviewStatus: "changes-requested",
      }),
      tmuxBackend: tmux(),
    });

    const log = await readFile(result.logFile, "utf8");
    expect(log).toContain("starting current-branch verification");
    expect(log).toContain("current-branch verification: build attribution evidence");
    expect(log).toContain("launching current-branch remediation attempt 1/2");
    expect(result.reviewSummary).toContain("coordinator-approved fix");
    expect(result.landingVerification).toContain("no rebase, merge-back, containment");
  });

  it("24. parses reviewer ReviewFinding[] output and preserves raw output", async () => {
    const repoRoot = await repo();
    const raw =
      '<review_report>{"summary":"needs edits","findings":[{"file":"src/task.ts","issue":"broken","suggestion":"fix it","severity":"fix"},{"file":"src/task.test.ts","issue":"name vague","suggestion":"rename","severity":"nit"}]}</review_report>';
    const result = await verify({
      worker: await currentWorker(repoRoot),
      runner: makeRunner({ reviewOutput: raw }),
      reviewEnabled: true,
      tmuxBackend: tmux(),
    });

    expect(result.reviewFindings).toEqual([
      { file: "src/task.ts", issue: "broken", suggestion: "fix it", severity: "fix" },
      { file: "src/task.test.ts", issue: "name vague", suggestion: "rename", severity: "nit" },
    ]);
    expect(result.reviewRawOutput).toContain("needs edits");
  });

  it("25. routes reviewer parse failures to attention with raw output and artifacts", async () => {
    const repoRoot = await repo();
    const result = await verify({
      worker: await currentWorker(repoRoot),
      runner: makeRunner({ reviewOutput: "not json from reviewer" }),
      reviewEnabled: true,
    });

    expect(result.status).toBe("attention");
    expect(result.reviewStatus).toBe("review-blocked");
    expect(result.reviewRawOutput).toContain("not json from reviewer");
    expect(result.reviewSummary).toContain("Raw output/artifacts are preserved");
    expect(result.lastError).toContain("Current-branch reviewer gate failed");
  });
});
