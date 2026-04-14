import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkerRuntime, WorkerSummary } from "./types.js";

type WorkerRegistryFile = {
  workers: WorkerRuntime[];
};

function normalizeWorkerStatus(value: unknown): WorkerRuntime["status"] {
  return value === "launching" ||
    value === "running" ||
    value === "exited" ||
    value === "landed" ||
    value === "failed"
    ? value
    : "failed";
}

function normalizeWorkerRuntime(input: unknown): WorkerRuntime | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const value = input as Partial<WorkerRuntime>;
  if (
    typeof value.workerId !== "string" ||
    typeof value.ticketId !== "string" ||
    typeof value.ticketTitle !== "string" ||
    typeof value.branchName !== "string" ||
    typeof value.worktreePath !== "string" ||
    typeof value.tmuxSession !== "string" ||
    typeof value.tmuxWindow !== "string" ||
    typeof value.tmuxPane !== "string" ||
    typeof value.runtimeDir !== "string" ||
    typeof value.promptFile !== "string" ||
    typeof value.scriptFile !== "string" ||
    typeof value.logFile !== "string" ||
    typeof value.stateFile !== "string" ||
    typeof value.exitCodeFile !== "string" ||
    typeof value.finishedAtFile !== "string" ||
    typeof value.launchCommand !== "string" ||
    typeof value.workerCommand !== "string" ||
    typeof value.cleanupPolicy !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }

  return {
    workerId: value.workerId,
    ticketId: value.ticketId,
    epicId: typeof value.epicId === "string" ? value.epicId : undefined,
    ticketTitle: value.ticketTitle,
    ticketStatus: typeof value.ticketStatus === "string" ? value.ticketStatus : undefined,
    branchName: value.branchName,
    worktreePath: value.worktreePath,
    backend: "tmux",
    tmuxSession: value.tmuxSession,
    tmuxWindow: value.tmuxWindow,
    tmuxPane: value.tmuxPane,
    runtimeDir: value.runtimeDir,
    promptFile: value.promptFile,
    scriptFile: value.scriptFile,
    logFile: value.logFile,
    stateFile: value.stateFile,
    exitCodeFile: value.exitCodeFile,
    finishedAtFile: value.finishedAtFile,
    launchCommand: value.launchCommand,
    workerCommand: value.workerCommand,
    workerProvider: typeof value.workerProvider === "string" ? value.workerProvider : undefined,
    workerModel: typeof value.workerModel === "string" ? value.workerModel : undefined,
    cleanupPolicy:
      value.cleanupPolicy === "cleanup-after-landing" ? "cleanup-after-landing" : "keep",
    cleanupStatus:
      value.cleanupStatus === "pending" ||
      value.cleanupStatus === "cleaned" ||
      value.cleanupStatus === "failed"
        ? value.cleanupStatus
        : undefined,
    cleanupAt: typeof value.cleanupAt === "string" ? value.cleanupAt : undefined,
    landingVerifiedAt:
      typeof value.landingVerifiedAt === "string" ? value.landingVerifiedAt : undefined,
    landingVerification:
      typeof value.landingVerification === "string" ? value.landingVerification : undefined,
    landingAheadCount:
      typeof value.landingAheadCount === "number" ? value.landingAheadCount : undefined,
    landingBehindCount:
      typeof value.landingBehindCount === "number" ? value.landingBehindCount : undefined,
    status: normalizeWorkerStatus(value.status),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : undefined,
    lastError: typeof value.lastError === "string" ? value.lastError : undefined,
  };
}

export function resolveWorkerRegistryPath(repoRoot: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(repoRoot, configuredPath);
}

export function resolveWorkerRuntimeDir(repoRoot: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(repoRoot, configuredPath);
}

export async function loadWorkerRegistry(registryPath: string): Promise<WorkerRuntime[]> {
  try {
    const raw = await readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as WorkerRegistryFile;
    if (!parsed || !Array.isArray(parsed.workers)) {
      return [];
    }

    return parsed.workers
      .map((worker) => normalizeWorkerRuntime(worker))
      .filter((worker): worker is WorkerRuntime => worker !== undefined);
  } catch {
    return [];
  }
}

export async function saveWorkerRegistry(
  registryPath: string,
  workers: WorkerRuntime[],
): Promise<WorkerRuntime[]> {
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify({ workers }, null, 2)}\n`, "utf8");
  return workers;
}

export async function upsertWorkerRuntime(
  registryPath: string,
  worker: WorkerRuntime,
): Promise<WorkerRuntime[]> {
  const workers = await loadWorkerRegistry(registryPath);
  const filtered = workers.filter((entry) => entry.workerId !== worker.workerId);
  filtered.push(worker);
  filtered.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return saveWorkerRegistry(registryPath, filtered);
}

export function summarizeWorkers(workers: WorkerRuntime[]): WorkerSummary {
  const summary: WorkerSummary = {
    total: workers.length,
    active: 0,
    launching: 0,
    running: 0,
    exited: 0,
    landed: 0,
    failed: 0,
    cleaned: 0,
  };

  for (const worker of workers) {
    if (worker.status === "launching") {
      summary.launching += 1;
      summary.active += 1;
    } else if (worker.status === "running") {
      summary.running += 1;
      summary.active += 1;
    } else if (worker.status === "exited") {
      summary.exited += 1;
    } else if (worker.status === "landed") {
      summary.landed += 1;
      if (worker.cleanupStatus === "cleaned") {
        summary.cleaned += 1;
      }
    } else if (worker.status === "failed") {
      summary.failed += 1;
    }
  }

  return summary;
}
