import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSuccessfulTerminalWorker, type WorkerRuntime, type WorkerSummary } from "./types.js";

type WorkerRecord = Record<string, unknown>;

const registryWriteQueues = new Map<string, Promise<unknown>>();

const WORKER_STATUSES = [
  "launching",
  "running",
  "exited",
  "held",
  "landed",
  "verified",
  "failed",
  "attention",
] as const satisfies readonly WorkerRuntime["status"][];

const CLEANUP_POLICIES = ["keep", "cleanup-after-landing"] as const;
const LANDING_POLICIES = ["auto", "deferred"] as const;
const CLEANUP_STATUSES = ["pending", "cleaned", "failed"] as const;
const VALIDATION_STATUSES = ["pending", "passed", "failed"] as const;
const REMEDIATION_STATUSES = ["running", "failed", "exhausted"] as const;
const REVIEW_STATUSES = [
  "pending",
  "approved",
  "nits-only",
  "changes-requested",
  "remediation-in-progress",
  "review-blocked",
] as const;
const REVIEW_VERDICTS = ["approve", "approve-with-nits", "request-changes"] as const;

const REQUIRED_STRING_FIELDS = [
  "workerId",
  "ticketId",
  "ticketTitle",
  "branchName",
  "tmuxSession",
  "tmuxWindow",
  "tmuxPane",
  "runtimeDir",
  "promptFile",
  "scriptFile",
  "logFile",
  "stateFile",
  "exitCodeFile",
  "finishedAtFile",
  "launchCommand",
  "workerCommand",
  "startedAt",
  "updatedAt",
] as const;

const OPTIONAL_STRING_FIELDS = [
  "epicId",
  "ticketStatus",
  "workerProvider",
  "workerModel",
  "reviewerProvider",
  "reviewerModel",
  "landingHeldAt",
  "landingRequestedAt",
  "cleanupAt",
  "validationAt",
  "validationSummary",
  "remediationAt",
  "remediationSummary",
  "reviewAt",
  "reviewSummary",
  "reviewedWorkerHead",
  "reviewRemediationAt",
  "landingRemediationAt",
  "landingRemediationSummary",
  "landingVerifiedAt",
  "landingVerification",
  "finishedAt",
  "lastError",
] as const;

const OPTIONAL_NUMBER_FIELDS = [
  "remediationAttempts",
  "reviewValidFeedbackCount",
  "reviewInvalidFeedbackCount",
  "reviewRemediationAttempts",
  "landingRemediationAttempts",
  "landingAheadCount",
  "landingBehindCount",
] as const;

const OPTIONAL_STRING_ARRAY_FIELDS = ["reviewFeedback", "commitShas", "touchedPaths"] as const;

function isRecord(value: unknown): value is WorkerRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function failRecord(message: string): never {
  throw new Error(`Invalid worker registry record: ${message}`);
}

function requireString(record: WorkerRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    failRecord(`missing or invalid string field "${field}"`);
  }
  return value;
}

function requireEnum<T extends readonly string[]>(
  record: WorkerRecord,
  field: string,
  allowed: T,
): T[number] {
  const value = record[field];
  if (typeof value !== "string" || !allowed.includes(value)) {
    failRecord(`missing or invalid field "${field}"; expected one of: ${allowed.join(", ")}`);
  }
  return value;
}

function validateOptionalString(record: WorkerRecord, field: string): void {
  if (record[field] !== undefined && typeof record[field] !== "string") {
    failRecord(`invalid optional string field "${field}"`);
  }
}

function validateOptionalNumber(record: WorkerRecord, field: string): void {
  if (record[field] !== undefined && typeof record[field] !== "number") {
    failRecord(`invalid optional number field "${field}"`);
  }
}

function validateOptionalStringArray(record: WorkerRecord, field: string): void {
  const value = record[field];
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
  ) {
    failRecord(`invalid optional string array field "${field}"`);
  }
}

function validateOptionalEnum<T extends readonly string[]>(
  record: WorkerRecord,
  field: string,
  allowed: T,
): void {
  if (record[field] !== undefined) {
    requireEnum(record, field, allowed);
  }
}

function parseWorkerRegistryJson(raw: string, registryPath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const trailingGarbageMatch = detail.match(/after JSON at position (\d+)/);
    if (trailingGarbageMatch) {
      const garbagePosition = Number.parseInt(trailingGarbageMatch[1]!, 10);
      const trailing = raw.slice(garbagePosition).trim();
      if (/^(?:[\]}]\s*)+$/.test(trailing)) {
        return JSON.parse(raw.slice(0, garbagePosition));
      }
    }
    throw new Error(`Failed to parse worker registry ${registryPath}: ${detail}`);
  }
}

async function writeRegistryFileAtomically(registryPath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(registryPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(registryPath),
    `.${path.basename(registryPath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, registryPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Best-effort cleanup; preserve the original write failure.
    }
    throw error;
  }
}

async function withRegistryWriteQueue<T>(
  registryPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = registryWriteQueues.get(registryPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  const queued = next.finally(() => {
    if (registryWriteQueues.get(registryPath) === queued) {
      registryWriteQueues.delete(registryPath);
    }
  });
  registryWriteQueues.set(registryPath, queued);
  return next;
}

function validateWorkerRecord(record: WorkerRecord): void {
  for (const field of REQUIRED_STRING_FIELDS) {
    requireString(record, field);
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    validateOptionalString(record, field);
  }
  for (const field of OPTIONAL_NUMBER_FIELDS) {
    validateOptionalNumber(record, field);
  }
  for (const field of OPTIONAL_STRING_ARRAY_FIELDS) {
    validateOptionalStringArray(record, field);
  }

  if (record.backend !== "tmux") {
    failRecord('missing or invalid field "backend"; expected "tmux"');
  }

  requireEnum(record, "status", WORKER_STATUSES);
  validateOptionalEnum(record, "cleanupPolicy", CLEANUP_POLICIES);
  validateOptionalEnum(record, "landingPolicy", LANDING_POLICIES);
  validateOptionalEnum(record, "cleanupStatus", CLEANUP_STATUSES);
  validateOptionalEnum(record, "validationStatus", VALIDATION_STATUSES);
  validateOptionalEnum(record, "remediationStatus", REMEDIATION_STATUSES);
  validateOptionalEnum(record, "reviewStatus", REVIEW_STATUSES);
  validateOptionalEnum(record, "reviewVerdict", REVIEW_VERDICTS);
}

export function normalizeWorkerRecord(raw: unknown): WorkerRuntime {
  if (!isRecord(raw)) {
    failRecord("expected an object");
  }

  const record = raw;
  validateWorkerRecord(record);

  if (record.executionMode === undefined) {
    const worktreePath = requireString(record, "worktreePath");
    return {
      ...record,
      executionMode: "worktree",
      checkoutPath: worktreePath,
    } as WorkerRuntime;
  }

  if (record.executionMode === "worktree") {
    requireString(record, "checkoutPath");
    requireString(record, "worktreePath");
    return record as WorkerRuntime;
  }

  if (record.executionMode === "current-branch") {
    requireString(record, "checkoutPath");
    requireString(record, "launchHead");
    const { worktreePath: _worktreePath, ...normalized } = record;
    return normalized as WorkerRuntime;
  }

  failRecord('invalid field "executionMode"; expected "worktree" or "current-branch"');
}

export function resolveWorkerRegistryPath(repoRoot: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(repoRoot, configuredPath);
}

export function resolveWorkerRuntimeDir(repoRoot: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(repoRoot, configuredPath);
}

export async function loadWorkerRegistry(registryPath: string): Promise<WorkerRuntime[]> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const parsed = parseWorkerRegistryJson(raw, registryPath);

  if (!isRecord(parsed) || !Array.isArray(parsed.workers)) {
    throw new Error(`Invalid worker registry ${registryPath}: expected object with workers array`);
  }

  return parsed.workers.map((worker, index) => {
    try {
      return normalizeWorkerRecord(worker);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid worker registry ${registryPath} record at index ${index}: ${detail}`,
      );
    }
  });
}

async function saveWorkerRegistryUnlocked(
  registryPath: string,
  workers: WorkerRuntime[],
): Promise<WorkerRuntime[]> {
  const normalizedWorkers = workers.map((worker) => normalizeWorkerRecord(worker));
  await writeRegistryFileAtomically(
    registryPath,
    `${JSON.stringify({ workers: normalizedWorkers }, null, 2)}\n`,
  );
  return normalizedWorkers;
}

export async function saveWorkerRegistry(
  registryPath: string,
  workers: WorkerRuntime[],
): Promise<WorkerRuntime[]> {
  return withRegistryWriteQueue(registryPath, () =>
    saveWorkerRegistryUnlocked(registryPath, workers),
  );
}

export async function upsertWorkerRuntime(
  registryPath: string,
  worker: WorkerRuntime,
): Promise<WorkerRuntime[]> {
  return withRegistryWriteQueue(registryPath, async () => {
    const workers = await loadWorkerRegistry(registryPath);
    const existing = workers.find((entry) => entry.workerId === worker.workerId);
    if (existing && existing.updatedAt > worker.updatedAt) {
      return workers;
    }

    const normalizedWorker = normalizeWorkerRecord(worker);
    const filtered = workers.filter((entry) => entry.workerId !== normalizedWorker.workerId);
    filtered.push(normalizedWorker);
    filtered.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    return saveWorkerRegistryUnlocked(registryPath, filtered);
  });
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
    verified: 0,
    successfulTerminal: 0,
    failed: 0,
    attention: 0,
    cleaned: 0,
    worktree: 0,
    currentBranch: 0,
    activeWorktree: 0,
    activeCurrentBranch: 0,
  };

  for (const worker of workers) {
    if (worker.executionMode === "worktree") {
      summary.worktree = (summary.worktree ?? 0) + 1;
      if (worker.status === "launching" || worker.status === "running") {
        summary.activeWorktree = (summary.activeWorktree ?? 0) + 1;
      }
    } else {
      summary.currentBranch = (summary.currentBranch ?? 0) + 1;
      if (worker.status === "launching" || worker.status === "running") {
        summary.activeCurrentBranch = (summary.activeCurrentBranch ?? 0) + 1;
      }
    }
    if (isSuccessfulTerminalWorker(worker)) {
      summary.successfulTerminal += 1;
      if (worker.cleanupStatus === "cleaned") {
        summary.cleaned += 1;
      }
    }

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
    } else if (worker.status === "verified") {
      summary.verified += 1;
    } else if (worker.status === "failed") {
      summary.failed += 1;
    } else if (worker.status === "attention") {
      summary.attention += 1;
    }
  }

  return summary;
}
