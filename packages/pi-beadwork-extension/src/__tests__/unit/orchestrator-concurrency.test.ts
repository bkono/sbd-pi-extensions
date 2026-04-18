import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BeadworkAdapter } from "../../bw.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import { runBoundedEpicLoop } from "../../orchestrator.js";
import { loadWorkerRegistry, resolveWorkerRegistryPath } from "../../registry.js";
import type { BeadworkIssueDetail } from "../../types.js";

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

async function createRepoRoot(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-limit-"));
  runGit(repoRoot, ["init"]);
  await writeFile(path.join(repoRoot, "README.md"), "# beadwork test\n", "utf8");
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "init"]);
  return repoRoot;
}

function createBarrier(size: number): () => Promise<void> {
  let waiting = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    waiting += 1;
    if (waiting === size) {
      release?.();
    }
    await pending;
  };
}

describe("run loop concurrency limits", () => {
  it("does not exceed the configured worker limit across concurrent run invocations", async () => {
    const repoRoot = await createRepoRoot();
    const readyBarrier = createBarrier(3);
    const readyIssues = Array.from({ length: 6 }, (_, index) =>
      createIssue({
        id: `BW-${101 + index}`,
        title: `Task ${index + 1}`,
        type: "task",
        parentId: "BW-100",
      }),
    );
    const issues = new Map<string, BeadworkIssueDetail>([
      [
        "BW-100",
        createIssue({
          id: "BW-100",
          title: "Epic",
          type: "epic",
          children: readyIssues,
        }),
      ],
      ...readyIssues.map((issue) => [issue.id, issue]),
    ]);

    const adapter = createAdapter({
      show: vi.fn().mockImplementation(async (_cwd, issueId) => {
        const issue = issues.get(issueId);
        if (!issue) {
          throw new Error(`Unknown issue: ${issueId}`);
        }
        return issue;
      }),
      ready: vi.fn().mockImplementation(async () => {
        await readyBarrier();
        return readyIssues;
      }),
    });

    let paneId = 0;
    const tmuxBackend = {
      ensureSession: vi.fn().mockResolvedValue(undefined),
      launchWorker: vi
        .fn()
        .mockImplementation(async ({ sessionName, workerId, launchCommand }) => ({
          sessionName,
          windowName: workerId,
          paneId: `%${++paneId}`,
          launchCommand,
        })),
      inspectWorker: vi.fn(),
      cleanupWorker: vi.fn(),
    };

    const options = {
      workers: 2,
      until: "blocked" as const,
      dryRun: false,
      maxCycles: 1,
      pollIntervalMs: 0,
      noSpawn: false,
    };

    const summaries = await Promise.all(
      Array.from({ length: 3 }, () =>
        runBoundedEpicLoop({
          cwd: repoRoot,
          repoRoot,
          config: DEFAULT_CONFIG,
          adapter,
          epicId: "BW-100",
          options,
          tmuxBackend,
        }),
      ),
    );

    const registryPath = resolveWorkerRegistryPath(
      repoRoot,
      DEFAULT_CONFIG.storage.workerRegistryFile,
    );
    const workers = await loadWorkerRegistry(registryPath);

    expect(tmuxBackend.launchWorker).toHaveBeenCalledTimes(2);
    expect(workers).toHaveLength(2);
    expect(workers.every((worker) => worker.status === "running")).toBe(true);
    expect(new Set(workers.map((worker) => worker.ticketId))).toEqual(
      new Set(["BW-101", "BW-102"]),
    );

    for (const summary of summaries) {
      expect(summary.workerSummary.active).toBeLessThanOrEqual(options.workers);
      expect(summary.activeWorkerIds).toHaveLength(2);
    }
  });
});
