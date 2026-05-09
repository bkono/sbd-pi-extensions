import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildAttributionEvidencePack } from "../../attribution.js";
import type { BeadworkAdapter } from "../../bw.js";
import type { ProcessRunner } from "../../process.js";
import type {
  BeadworkHistoryEntry,
  BeadworkIssueDetail,
  CurrentBranchCheckout,
  WorkerRuntime,
} from "../../types.js";

function createIssue(overrides: Partial<BeadworkIssueDetail> = {}): BeadworkIssueDetail {
  return {
    id: "BW-101",
    title: "Task",
    description: "Implement the task.",
    status: "closed",
    type: "task",
    priority: 1,
    labels: [],
    blockedBy: [],
    blocks: [],
    assignee: "",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T01:00:00.000Z",
    parentId: "EPIC-1",
    children: [],
    ...overrides,
  };
}

function createWorker(
  overrides: Partial<WorkerRuntime & CurrentBranchCheckout> = {},
): WorkerRuntime & CurrentBranchCheckout {
  return {
    workerId: "bw-101-worker",
    ticketId: "BW-101",
    epicId: "EPIC-1",
    ticketTitle: "Task",
    ticketStatus: "closed",
    backend: "tmux",
    tmuxSession: "pi-bw",
    tmuxWindow: "bw-101",
    tmuxPane: "%42",
    runtimeDir: "/tmp/runtime",
    promptFile: "/tmp/runtime/prompt.txt",
    scriptFile: "/tmp/runtime/launch.sh",
    logFile: "/tmp/runtime/worker.log",
    stateFile: "/tmp/runtime/state.json",
    exitCodeFile: "/tmp/runtime/exit-code.txt",
    finishedAtFile: "/tmp/runtime/finished-at.txt",
    launchCommand: "bash /tmp/runtime/launch.sh",
    workerCommand: "pi --mode json",
    validationStatus: "passed",
    validationSummary: "lint/test/typecheck passed",
    status: "exited",
    startedAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T01:00:00.000Z",
    finishedAt: "2026-05-08T01:00:00.000Z",
    executionMode: "current-branch",
    checkoutPath: "/repo",
    branchName: "main",
    launchHead: "launch-head",
    ...overrides,
  };
}

function createAdapter(input: {
  issues?: BeadworkIssueDetail[];
  history?: BeadworkHistoryEntry[];
}): BeadworkAdapter {
  const issues = new Map((input.issues ?? []).map((issue) => [issue.id, issue]));
  return {
    prime: vi.fn(),
    ready: vi.fn(),
    blocked: vi.fn(),
    list: vi.fn(),
    show: vi.fn(async (_cwd: string, id: string) => {
      const issue = issues.get(id);
      if (!issue) {
        throw new Error(`missing issue ${id}`);
      }
      return issue;
    }),
    history: vi.fn(async () => input.history ?? []),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    comment: vi.fn(),
    label: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    reopen: vi.fn(),
    defer: vi.fn(),
    undefer: vi.fn(),
    sync: vi.fn(),
    getCounts: vi.fn(),
  } as BeadworkAdapter;
}

function ok(stdout = "") {
  return { stdout, stderr: "", code: 0 };
}

function fail(stderr = "failed") {
  return { stdout: "", stderr, code: 1 };
}

function createRunner(overrides: Record<string, ReturnType<typeof ok>> = {}): ProcessRunner {
  return vi.fn(async (command: string, args: string[]) => {
    if (command !== "git") {
      throw new Error(`unexpected command ${command}`);
    }
    const key = args.join(" ");
    const base: Record<string, ReturnType<typeof ok>> = {
      "rev-parse --abbrev-ref HEAD": ok("main\n"),
      "rev-parse HEAD": ok("head-sha\n"),
      "merge-base --is-ancestor launch-head HEAD": ok(),
      "log --format=%H%x09%s launch-head..HEAD --grep=BW-101": ok(
        "aaaaaaa\tBW-101 implement task\n",
      ),
      "log --max-count=20 --format=%H%x09%s launch-head..HEAD": ok(
        "aaaaaaa\tBW-101 implement task\nccccccc\tmaintain nearby context\n",
      ),
      "merge-base --is-ancestor aaaaaaa HEAD": ok(),
      "merge-base --is-ancestor ccccccc HEAD": ok(),
      "show --name-only --format= aaaaaaa": ok("src/task.ts\nsrc/task.test.ts\n"),
      "show --name-only --format= ccccccc": ok("docs/context.md\n"),
    };
    return overrides[key] ?? base[key] ?? ok();
  });
}

function createDefaultIssues(): BeadworkIssueDetail[] {
  return [
    createIssue({
      children: [createIssue({ id: "BW-101.1", title: "Child", parentId: "BW-101" })],
      blockedBy: ["BW-090"],
      blocks: ["BW-102"],
    }),
    createIssue({
      id: "EPIC-1",
      title: "Epic",
      description: "Ship current-branch attribution.",
      type: "epic",
      parentId: undefined,
    }),
    createIssue({ id: "BW-090", title: "Blocker", parentId: "EPIC-1" }),
    createIssue({ id: "BW-102", title: "Blocked follow-up", parentId: "EPIC-1" }),
  ];
}

describe("buildAttributionEvidencePack", () => {
  it("renders all major attribution sections for a well-behaved current-branch worker", async () => {
    const pack = await buildAttributionEvidencePack({
      worker: createWorker(),
      adapter: createAdapter({
        issues: createDefaultIssues(),
        history: [
          {
            timestamp: "2026-05-08T01:00:00.000Z",
            author: "worker",
            intent: "comment",
            message: "Handoff: committed aaaaaaa; validation passed.",
          },
        ],
      }),
      processRunner: createRunner(),
    });

    expect(pack.renderedText).toContain("## Ticket context");
    expect(pack.renderedText).toContain("## Beadwork comments and history evidence");
    expect(pack.renderedText).toContain("## Worker handoff and validation evidence");
    expect(pack.renderedText).toContain("## Strong candidate commits after launchHead");
    expect(pack.renderedText).toContain("## Bounded post-launch commit context");
    expect(pack.renderedText).toContain("## Derived touched paths");
    expect(pack.renderedText).toContain("Ship current-branch attribution.");
    expect(pack.renderedText).toContain("BW-090 [closed/task] Blocker");
    expect(pack.renderedText).toContain("BW-102 [closed/task] Blocked follow-up");
    expect(pack.attention).toEqual([]);
  });

  it("handles missing comments and handoff evidence gracefully", async () => {
    const pack = await buildAttributionEvidencePack({
      worker: createWorker(),
      adapter: createAdapter({ issues: createDefaultIssues(), history: [] }),
      processRunner: createRunner(),
    });

    expect(pack.renderedText).toContain("No beadwork comments/history entries were returned.");
    expect(pack.renderedText).toContain("No handoff-like history entries were detected");
  });

  it("finds ticket-id commits after launchHead and derives touched paths", async () => {
    const pack = await buildAttributionEvidencePack({
      worker: createWorker(),
      adapter: createAdapter({ issues: createDefaultIssues(), history: [] }),
      processRunner: createRunner(),
    });

    expect(pack.candidateCommits).toHaveLength(1);
    expect(pack.candidateCommits[0]).toMatchObject({
      sha: "aaaaaaa",
      subject: "BW-101 implement task",
      ancestry: "ancestor",
      touchedPaths: ["src/task.ts", "src/task.test.ts"],
    });
  });

  it("represents valid omitted-ticket-id commits through comments and bounded context", async () => {
    const runner = createRunner({
      "log --format=%H%x09%s launch-head..HEAD --grep=BW-101": ok(""),
      "log --max-count=20 --format=%H%x09%s launch-head..HEAD": ok(
        "bbbbbbb\timplement attribution helper without ticket id\n",
      ),
      "merge-base --is-ancestor bbbbbbb HEAD": ok(),
      "show --name-only --format= bbbbbbb": ok("src/attribution.ts\n"),
    });

    const pack = await buildAttributionEvidencePack({
      worker: createWorker(),
      adapter: createAdapter({
        issues: createDefaultIssues(),
        history: [{ intent: "comment", message: "Handoff names commit bbbbbbb for BW-101." }],
      }),
      processRunner: runner,
    });

    expect(pack.candidateCommits[0]).toMatchObject({
      sha: "bbbbbbb",
      subject: "implement attribution helper without ticket id",
      touchedPaths: ["src/attribution.ts"],
    });
    expect(pack.renderedText).toContain("ticket id not present in strong grep");
    expect(pack.renderedText).toContain("Missing ticket ids are not an automatic failure");
  });

  it("detects branch drift from the recorded launch branch", async () => {
    const pack = await buildAttributionEvidencePack({
      worker: createWorker(),
      adapter: createAdapter({ issues: createDefaultIssues(), history: [] }),
      processRunner: createRunner({ "rev-parse --abbrev-ref HEAD": ok("feature/drift\n") }),
    });

    expect(pack.branch.drift).toBe(true);
    expect(pack.attention.join("\n")).toContain("Branch drift detected");
    expect(pack.renderedText).toContain("branch drift: YES - route to attention");
  });

  it("represents explicit detached-HEAD launch without false branch drift", async () => {
    const pack = await buildAttributionEvidencePack({
      worker: createWorker({ branchName: "HEAD" }),
      adapter: createAdapter({ issues: createDefaultIssues(), history: [] }),
      processRunner: createRunner({ "rev-parse --abbrev-ref HEAD": ok("HEAD\n") }),
    });

    expect(pack.branch.detachedHeadLaunch).toBe(true);
    expect(pack.branch.drift).toBe(false);
    expect(pack.attention.join("\n")).not.toContain("Branch drift detected");
    expect(pack.renderedText).toContain("detached HEAD launch: YES");
  });

  it("surfaces launch-head and candidate ancestry failures for later attention", async () => {
    const pack = await buildAttributionEvidencePack({
      worker: createWorker(),
      adapter: createAdapter({ issues: createDefaultIssues(), history: [] }),
      processRunner: createRunner({
        "merge-base --is-ancestor launch-head HEAD": fail("launch head missing"),
        "merge-base --is-ancestor aaaaaaa HEAD": fail("candidate missing"),
      }),
    });

    expect(pack.launchHead.ancestry).toBe("not-ancestor");
    expect(pack.candidateCommits[0]?.ancestry).toBe("not-ancestor");
    expect(pack.attention.join("\n")).toContain("Launch head launch-head is not an ancestor");
    expect(pack.attention.join("\n")).toContain("Commit aaaaaaa is not an ancestor");
  });

  it("includes runtime, log, prompt, state, and exit-code pointers with readable snippets", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-bw-attribution-"));
    const runtimeDir = path.join(tmp, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    const worker = createWorker({
      checkoutPath: tmp,
      runtimeDir,
      promptFile: path.join(runtimeDir, "prompt.txt"),
      logFile: path.join(runtimeDir, "worker.log"),
      stateFile: path.join(runtimeDir, "state.txt"),
      exitCodeFile: path.join(runtimeDir, "exit-code.txt"),
      finishedAtFile: path.join(runtimeDir, "finished-at.txt"),
      scriptFile: path.join(runtimeDir, "launch.sh"),
    });
    await writeFile(worker.promptFile, "Prompt body for BW-101", "utf8");
    await writeFile(worker.logFile, "worker log line", "utf8");
    await writeFile(worker.stateFile, "exited", "utf8");
    await writeFile(worker.exitCodeFile, "0", "utf8");
    await writeFile(worker.finishedAtFile, "2026-05-08T01:00:00.000Z", "utf8");

    const pack = await buildAttributionEvidencePack({
      worker,
      adapter: createAdapter({ issues: createDefaultIssues(), history: [] }),
      processRunner: createRunner(),
    });

    expect(pack.renderedText).toContain(`promptFile: ${worker.promptFile}`);
    expect(pack.renderedText).toContain(`logFile: ${worker.logFile}`);
    expect(pack.renderedText).toContain("stateFile:");
    expect(pack.renderedText).toContain("exitCodeFile:");
    expect(pack.renderedText).toContain("Prompt body for BW-101");
    expect(pack.renderedText).toContain("worker log line");
    expect(pack.renderedText).toContain("registry snapshot pointer");
  });
});
