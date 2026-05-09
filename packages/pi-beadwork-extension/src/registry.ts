import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkerCheckout, WorkerRuntime, WorkerSummary } from "./types.js";

type WorkerRegistryFile = {
  workers: WorkerRuntime[];
};

function normalizeWorkerStatus(value: unknown): WorkerRuntime["status"] {
  return value === "launching" ||
    value === "running" ||
    value === "exited" ||
    value === "held" ||
    value === "landed" ||
    value === "failed" ||
    value === "attention"
    ? value
    : "failed";
}

function normalizeWorkerRuntime(input: unknown): WorkerRuntime | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const value = input as Partial<WorkerRuntime> & {
    checkoutPath?: unknown;
    executionMode?: unknown;
    launchHead?: unknown;
    worktreePath?: unknown;
  };
  const executionMode = value.executionMode === "current-branch" ? "current-branch" : "worktree";
  const worktreePath =
    typeof value.worktreePath === "string"
      ? value.worktreePath
      : typeof value.checkoutPath === "string" && executionMode === "worktree"
        ? value.checkoutPath
        : undefined;
  const checkoutPath =
    typeof value.checkoutPath === "string"
      ? value.checkoutPath
      : executionMode === "worktree"
        ? worktreePath
        : undefined;

  if (
    typeof value.workerId !== "string" ||
    typeof value.ticketId !== "string" ||
    typeof value.ticketTitle !== "string" ||
    typeof value.branchName !== "string" ||
    typeof checkoutPath !== "string" ||
    (executionMode === "worktree" && typeof worktreePath !== "string") ||
    (executionMode === "current-branch" && typeof value.launchHead !== "string") ||
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
    typeof value.startedAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }

  const checkout: WorkerCheckout =
    executionMode === "current-branch"
      ? {
          executionMode,
          checkoutPath,
          branchName: value.branchName,
          launchHead: value.launchHead as string,
        }
      : {
          executionMode,
          checkoutPath,
          branchName: value.branchName,
          worktreePath: worktreePath as string,
        };

  return {
    ...checkout,
    workerId: value.workerId,
    ticketId: value.ticketId,
    epicId: typeof value.epicId === "string" ? value.epicId : undefined,
    ticketTitle: value.ticketTitle,
    ticketStatus: typeof value.ticketStatus === "string" ? value.ticketStatus : undefined,
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
    reviewerProvider:
      typeof value.reviewerProvider === "string" ? value.reviewerProvider : undefined,
    reviewerModel: typeof value.reviewerModel === "string" ? value.reviewerModel : undefined,
    cleanupPolicy:
      executionMode === "worktree"
        ? value.cleanupPolicy === "cleanup-after-landing"
          ? "cleanup-after-landing"
          : "keep"
        : undefined,
    landingPolicy:
      value.landingPolicy === "deferred" || value.landingPolicy === "auto"
        ? value.landingPolicy
        : undefined,
    landingHeldAt: typeof value.landingHeldAt === "string" ? value.landingHeldAt : undefined,
    landingRequestedAt:
      typeof value.landingRequestedAt === "string" ? value.landingRequestedAt : undefined,
    cleanupStatus:
      value.cleanupStatus === "pending" ||
      value.cleanupStatus === "cleaned" ||
      value.cleanupStatus === "failed"
        ? value.cleanupStatus
        : undefined,
    cleanupAt: typeof value.cleanupAt === "string" ? value.cleanupAt : undefined,
    validationStatus:
      value.validationStatus === "pending" ||
      value.validationStatus === "passed" ||
      value.validationStatus === "failed"
        ? value.validationStatus
        : undefined,
    validationAt: typeof value.validationAt === "string" ? value.validationAt : undefined,
    validationSummary:
      typeof value.validationSummary === "string" ? value.validationSummary : undefined,
    remediationStatus:
      value.remediationStatus === "running" ||
      value.remediationStatus === "failed" ||
      value.remediationStatus === "exhausted"
        ? value.remediationStatus
        : undefined,
    remediationAttempts:
      typeof value.remediationAttempts === "number" ? value.remediationAttempts : undefined,
    remediationAt: typeof value.remediationAt === "string" ? value.remediationAt : undefined,
    remediationSummary:
      typeof value.remediationSummary === "string" ? value.remediationSummary : undefined,
    reviewStatus:
      value.reviewStatus === "pending" ||
      value.reviewStatus === "approved" ||
      value.reviewStatus === "nits-only" ||
      value.reviewStatus === "changes-requested" ||
      value.reviewStatus === "remediation-in-progress" ||
      value.reviewStatus === "review-blocked"
        ? value.reviewStatus
        : undefined,
    reviewVerdict:
      value.reviewVerdict === "approve" ||
      value.reviewVerdict === "approve-with-nits" ||
      value.reviewVerdict === "request-changes"
        ? value.reviewVerdict
        : undefined,
    reviewAt: typeof value.reviewAt === "string" ? value.reviewAt : undefined,
    reviewSummary: typeof value.reviewSummary === "string" ? value.reviewSummary : undefined,
    reviewFeedback:
      Array.isArray(value.reviewFeedback) &&
      value.reviewFeedback.every((entry) => typeof entry === "string")
        ? value.reviewFeedback
        : undefined,
    reviewValidFeedbackCount:
      typeof value.reviewValidFeedbackCount === "number"
        ? value.reviewValidFeedbackCount
        : undefined,
    reviewInvalidFeedbackCount:
      typeof value.reviewInvalidFeedbackCount === "number"
        ? value.reviewInvalidFeedbackCount
        : undefined,
    reviewedWorkerHead:
      typeof value.reviewedWorkerHead === "string" ? value.reviewedWorkerHead : undefined,
    reviewRemediationAttempts:
      typeof value.reviewRemediationAttempts === "number"
        ? value.reviewRemediationAttempts
        : undefined,
    reviewRemediationAt:
      typeof value.reviewRemediationAt === "string" ? value.reviewRemediationAt : undefined,
    landingRemediationAttempts:
      typeof value.landingRemediationAttempts === "number"
        ? value.landingRemediationAttempts
        : undefined,
    landingRemediationAt:
      typeof value.landingRemediationAt === "string" ? value.landingRemediationAt : undefined,
    landingRemediationSummary:
      typeof value.landingRemediationSummary === "string"
        ? value.landingRemediationSummary
        : undefined,
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
    commitShas:
      Array.isArray(value.commitShas) &&
      value.commitShas.every((entry) => typeof entry === "string")
        ? value.commitShas
        : undefined,
    touchedPaths:
      Array.isArray(value.touchedPaths) &&
      value.touchedPaths.every((entry) => typeof entry === "string")
        ? value.touchedPaths
        : undefined,
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
  const existing = workers.find((entry) => entry.workerId === worker.workerId);
  if (existing && existing.updatedAt > worker.updatedAt) {
    return workers;
  }

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
    held: 0,
    landed: 0,
    failed: 0,
    attention: 0,
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
    } else if (worker.status === "held") {
      summary.held += 1;
    } else if (worker.status === "landed") {
      summary.landed += 1;
      if (worker.cleanupStatus === "cleaned") {
        summary.cleaned += 1;
      }
    } else if (worker.status === "failed") {
      summary.failed += 1;
    } else if (worker.status === "attention") {
      summary.attention += 1;
    }
  }

  return summary;
}
