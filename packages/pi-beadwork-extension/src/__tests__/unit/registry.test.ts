import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadWorkerRegistry,
  normalizeWorkerRecord,
  resolveWorkerRegistryPath,
  saveWorkerRegistry,
  upsertWorkerRuntime,
} from "../../registry.js";
import type { WorkerRuntime } from "../../types.js";

function worktreeWorker(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
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
    landingPolicy: "deferred",
    validationStatus: "passed",
    reviewFeedback: ["nit"],
    commitShas: ["abc123"],
    touchedPaths: ["src/registry.ts"],
    status: "held",
    startedAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:01.000Z",
    ...overrides,
  };
}

function currentBranchWorker(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  const { cleanupPolicy: _cleanupPolicy, worktreePath: _worktreePath, ...base } = worktreeWorker();
  return {
    ...base,
    workerId: "bw-102-worker",
    ticketId: "BW-102",
    executionMode: "current-branch",
    checkoutPath: "/repo",
    branchName: "main",
    launchHead: "abc123",
    ...overrides,
  };
}

function legacyWorkerRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const {
    executionMode: _executionMode,
    checkoutPath: _checkoutPath,
    ...legacy
  } = worktreeWorker();
  return {
    ...legacy,
    ...overrides,
  };
}

describe("worker registry normalization", () => {
  it("normalizes legacy records without executionMode to worktree workers", () => {
    const legacy = legacyWorkerRecord({ worktreePath: "/repo-root-even-if-weird" });

    const normalized = normalizeWorkerRecord(legacy);

    expect(normalized.executionMode).toBe("worktree");
    expect(normalized.checkoutPath).toBe("/repo-root-even-if-weird");
    expect(normalized.worktreePath).toBe("/repo-root-even-if-weird");
  });

  it("preserves all legacy fields while adding normalized checkout fields", () => {
    const legacy = legacyWorkerRecord({
      checkoutPath: "/stale-value",
      extraLegacyField: { keep: true },
      remediationAttempts: 2,
    });

    const normalized = normalizeWorkerRecord(legacy) as WorkerRuntime & {
      extraLegacyField: { keep: boolean };
    };

    expect(normalized).toMatchObject({
      ...legacy,
      executionMode: "worktree",
      checkoutPath: legacy.worktreePath,
    });
    expect(normalized.extraLegacyField).toEqual({ keep: true });
    expect(normalized.remediationAttempts).toBe(2);
  });

  it("passes new current-branch records through without worktreePath", () => {
    const worker = currentBranchWorker();

    const normalized = normalizeWorkerRecord(worker);

    expect(normalized).toEqual(worker);
    expect("worktreePath" in normalized).toBe(false);
  });

  it("strips spoofed worktreePath from current-branch records during normalization", () => {
    const spoofed = {
      ...currentBranchWorker(),
      worktreePath: "/repo",
      extraCurrentBranchField: { keep: true },
    };

    const normalized = normalizeWorkerRecord(spoofed) as WorkerRuntime & {
      extraCurrentBranchField: { keep: boolean };
    };

    expect(normalized.executionMode).toBe("current-branch");
    expect(normalized.checkoutPath).toBe("/repo");
    expect("worktreePath" in normalized).toBe(false);
    expect(normalized.extraCurrentBranchField).toEqual({ keep: true });
  });

  it("drops spoofed current-branch worktreePath during save", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-registry-"));
    const registryPath = path.join(tempDir, "registry.json");
    const spoofed = { ...currentBranchWorker(), worktreePath: "/repo" } as unknown as WorkerRuntime;

    const savedWorkers = await saveWorkerRegistry(registryPath, [spoofed]);
    const saved = JSON.parse(await readFile(registryPath, "utf8")) as { workers: WorkerRuntime[] };

    expect("worktreePath" in savedWorkers[0]!).toBe(false);
    expect("worktreePath" in saved.workers[0]!).toBe(false);
  });

  it("passes new worktree records through unchanged", () => {
    const worker = worktreeWorker();

    expect(normalizeWorkerRecord(worker)).toEqual(worker);
  });

  it("preserves explicit worktreePath on new worktree records", () => {
    const worker = worktreeWorker({ worktreePath: "/tmp/isolated", checkoutPath: "/tmp/isolated" });

    const normalized = normalizeWorkerRecord(worker);

    expect(normalized).toEqual(worker);
    expect(normalized.worktreePath).toBe("/tmp/isolated");
  });

  it("preserves normalized legacy records across load/save round trips", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-registry-"));
    const registryPath = path.join(tempDir, "registry.json");
    const legacy = legacyWorkerRecord({ worktreePath: path.join(tempDir, "worker") });

    await writeFile(registryPath, JSON.stringify({ workers: [legacy] }, null, 2), "utf8");

    const loaded = await loadWorkerRegistry(registryPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      executionMode: "worktree",
      checkoutPath: path.join(tempDir, "worker"),
      worktreePath: path.join(tempDir, "worker"),
    });

    await saveWorkerRegistry(registryPath, loaded);
    const saved = JSON.parse(await readFile(registryPath, "utf8")) as { workers: WorkerRuntime[] };

    expect(saved.workers).toEqual(loaded);
    expect(saved.workers[0]?.executionMode).toBe("worktree");
    expect(saved.workers[0]?.checkoutPath).toBe(path.join(tempDir, "worker"));
  });

  it("loads persisted local .pi/beadwork registry records with legacy and current-branch shapes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-local-registry-"));
    const repoRoot = path.join(tempDir, "sbd-pi-extensions");
    const registryPath = resolveWorkerRegistryPath(repoRoot, ".pi/beadwork/workers/registry.json");
    const legacyWorktree = legacyWorkerRecord({
      workerId: "sbdpi-qmd.1.1-moxq4a3t-wqjo23",
      ticketId: "sbdpi-qmd.1.1",
      epicId: "sbdpi-qmd",
      ticketTitle: "Add WorkerExecutionMode discriminated union types to types.ts",
      ticketStatus: "open",
      branchName: "sbdpi-qmd.1.1/add-workerexecutionmode-discriminated-union-type",
      worktreePath: path.join(
        tempDir,
        "sbd-pi-extensions-worktrees/sbdpi-qmd.1.1-add-workerexecutionmode-discriminated-union-type",
      ),
      runtimeDir: path.join(repoRoot, ".pi/beadwork/workers/runtime/sbdpi-qmd.1.1-moxq4a3t-wqjo23"),
      status: "running",
    });
    const currentBranch = currentBranchWorker({
      workerId: "sbdpi-qmd.3.5-current-branch",
      ticketId: "sbdpi-qmd.3.5",
      epicId: "sbdpi-qmd",
      ticketTitle: "Cover current-branch verification regressions",
      ticketStatus: "closed",
      checkoutPath: repoRoot,
      branchName: "sbdpi-qmd.3.5/current-branch-verification-regressions",
      launchHead: "09f3011",
      status: "verified",
      landingVerifiedAt: "2026-05-09T03:00:00.000Z",
      landingVerification: "Landing verified: current branch HEAD is unchanged.",
    });
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(
      registryPath,
      `${JSON.stringify({ workers: [legacyWorktree, currentBranch] }, null, 2)}\n`,
      "utf8",
    );

    const loaded = await loadWorkerRegistry(registryPath);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({
      executionMode: "worktree",
      checkoutPath: legacyWorktree.worktreePath,
      worktreePath: legacyWorktree.worktreePath,
      status: "running",
    });
    expect(loaded[1]).toMatchObject({
      executionMode: "current-branch",
      checkoutPath: repoRoot,
      launchHead: "09f3011",
      status: "verified",
    });
    expect("worktreePath" in loaded[1]!).toBe(false);
  });

  it("recovers local registry files left with duplicated trailing object closers", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-local-registry-"));
    const repoRoot = path.join(tempDir, "sbd-pi-extensions");
    const registryPath = resolveWorkerRegistryPath(repoRoot, ".pi/beadwork/workers/registry.json");
    const worker = legacyWorkerRecord({
      workerId: "sbdpi-qmd.1.2-moxq4aao-3e5s49",
      ticketId: "sbdpi-qmd.1.2",
      epicId: "sbdpi-qmd",
      ticketTitle: "Add workerExecution config block with mode and maxLifetime",
      ticketStatus: "in_progress",
      branchName: "sbdpi-qmd.1.2/add-workerexecution-config-block-with-mode-and-m",
      worktreePath: path.join(
        tempDir,
        "sbd-pi-extensions-worktrees/sbdpi-qmd.1.2-add-workerexecution-config-block-with-mode-and-m",
      ),
      status: "running",
    });
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(
      registryPath,
      `${JSON.stringify({ workers: [worker] }, null, 2)}\n\n  ]\n}\n`,
      "utf8",
    );

    const loaded = await loadWorkerRegistry(registryPath);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      executionMode: "worktree",
      checkoutPath: worker.worktreePath,
      worktreePath: worker.worktreePath,
      status: "running",
    });
  });

  it("serializes concurrent upserts against the local registry path without dropping workers", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-local-registry-"));
    const repoRoot = path.join(tempDir, "sbd-pi-extensions");
    const registryPath = resolveWorkerRegistryPath(repoRoot, ".pi/beadwork/workers/registry.json");
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, `${JSON.stringify({ workers: [] }, null, 2)}\n`, "utf8");
    const workers = Array.from({ length: 4 }, (_, index) =>
      worktreeWorker({
        workerId: `sbdpi-qmd.2.${index + 1}-worker`,
        ticketId: `sbdpi-qmd.2.${index + 1}`,
        startedAt: `2026-05-09T03:00:0${index}.000Z`,
        updatedAt: `2026-05-09T03:00:0${index}.000Z`,
      }),
    );

    await Promise.all(workers.map((worker) => upsertWorkerRuntime(registryPath, worker)));

    const loaded = await loadWorkerRegistry(registryPath);
    expect(loaded.map((worker) => worker.workerId)).toEqual(
      workers.map((worker) => worker.workerId),
    );
    expect(JSON.parse(await readFile(registryPath, "utf8"))).toMatchObject({
      workers: expect.arrayContaining(
        workers.map((worker) => expect.objectContaining({ workerId: worker.workerId })),
      ),
    });
  });
  it("throws clear errors for malformed records", async () => {
    const { workerId: _workerId, ...missingWorkerId } = legacyWorkerRecord();
    expect(() => normalizeWorkerRecord(missingWorkerId)).toThrow(/workerId/);

    expect(() => normalizeWorkerRecord({ ...legacyWorkerRecord(), status: "surprised" })).toThrow(
      /status/,
    );

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-registry-"));
    const registryPath = path.join(tempDir, "registry.json");
    const { ticketId: _ticketId, ...missingTicketId } = legacyWorkerRecord();
    await writeFile(registryPath, JSON.stringify({ workers: [missingTicketId] }), "utf8");

    await expect(loadWorkerRegistry(registryPath)).rejects.toThrow(/index 0.*ticketId/);
  });
});
