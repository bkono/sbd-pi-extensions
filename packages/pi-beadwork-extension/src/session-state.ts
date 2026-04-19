import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SESSION_STATE } from "./constants.js";
import type {
  PrimeCache,
  RunCycleSummary,
  RunSummary,
  SessionRunOptions,
  SessionScope,
  SessionState,
  WorkerSummary,
} from "./types.js";

function normalizeScope(scope: unknown): SessionScope {
  if (!scope || typeof scope !== "object") {
    return { kind: "none" };
  }

  const value = scope as Partial<SessionScope> & { id?: unknown; title?: unknown };
  const title = typeof value.title === "string" && value.title.length > 0 ? value.title : undefined;

  if (value.kind === "ticket" && typeof value.id === "string" && value.id.length > 0) {
    return { kind: "ticket", id: value.id, title };
  }
  if (value.kind === "epic" && typeof value.id === "string" && value.id.length > 0) {
    return { kind: "epic", id: value.id, title };
  }

  return { kind: "none" };
}

function normalizePrimeCache(prime: unknown): PrimeCache | undefined {
  if (!prime || typeof prime !== "object") {
    return undefined;
  }

  const value = prime as Partial<PrimeCache>;
  if (typeof value.content !== "string" || value.content.length === 0) {
    return undefined;
  }

  return {
    content: value.content,
    loadedAt: typeof value.loadedAt === "string" ? value.loadedAt : new Date().toISOString(),
    repoRoot: typeof value.repoRoot === "string" ? value.repoRoot : undefined,
  };
}

function normalizeTrackedWorkerIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const ids = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

function normalizeWorkerNotices(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      typeof entry[0] === "string" && entry[0].length > 0 && typeof entry[1] === "string",
  );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function normalizeRunOptions(value: unknown): SessionRunOptions | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const parsed = value as Partial<SessionRunOptions>;
  const workers = normalizePositiveInteger(parsed.workers);
  const until = parsed.until === "empty" || parsed.until === "blocked" ? parsed.until : undefined;

  if (!workers || !until) {
    return undefined;
  }

  return {
    workers,
    until,
    noSpawn: parsed.noSpawn === true,
    dryRun: parsed.dryRun === true,
    maxCycles: normalizePositiveInteger(parsed.maxCycles),
  };
}

function normalizeWorkerSummary(value: unknown): WorkerSummary | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const parsed = value as Partial<WorkerSummary>;
  return {
    total: normalizePositiveInteger(parsed.total) ?? 0,
    active: normalizePositiveInteger(parsed.active) ?? 0,
    launching: normalizePositiveInteger(parsed.launching) ?? 0,
    running: normalizePositiveInteger(parsed.running) ?? 0,
    exited: normalizePositiveInteger(parsed.exited) ?? 0,
    held: normalizePositiveInteger(parsed.held) ?? 0,
    landed: normalizePositiveInteger(parsed.landed) ?? 0,
    failed: normalizePositiveInteger(parsed.failed) ?? 0,
    attention: normalizePositiveInteger(parsed.attention) ?? 0,
    cleaned: normalizePositiveInteger(parsed.cleaned) ?? 0,
  };
}

function normalizeRunCycleSummary(value: unknown): RunCycleSummary | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const parsed = value as Partial<RunCycleSummary>;
  const cycle = normalizePositiveInteger(parsed.cycle);
  if (!cycle) {
    return undefined;
  }

  return {
    cycle,
    ready: normalizeStringArray(parsed.ready),
    launched: normalizeStringArray(parsed.launched),
    running: normalizeStringArray(parsed.running),
    held: normalizeStringArray(parsed.held),
    landed: normalizeStringArray(parsed.landed),
    failed: normalizeStringArray(parsed.failed),
    attention: normalizeStringArray(parsed.attention),
    exited: normalizeStringArray(parsed.exited),
  };
}

function normalizeRunSummary(value: unknown): RunSummary | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const parsed = value as Partial<RunSummary>;
  const workerSummary = normalizeWorkerSummary(parsed.workerSummary);
  if (
    typeof parsed.epicId !== "string" ||
    parsed.epicId.length === 0 ||
    !workerSummary ||
    (parsed.stopReason !== "completed" &&
      parsed.stopReason !== "blocked" &&
      parsed.stopReason !== "empty" &&
      parsed.stopReason !== "max-cycles" &&
      parsed.stopReason !== "attention")
  ) {
    return undefined;
  }

  return {
    epicId: parsed.epicId,
    stopReason: parsed.stopReason,
    cycles: normalizePositiveInteger(parsed.cycles) ?? 0,
    launched: normalizeStringArray(parsed.launched),
    activeWorkerIds: normalizeStringArray(parsed.activeWorkerIds),
    workerSummary,
    notes: normalizeStringArray(parsed.notes),
    cycleSummaries: Array.isArray(parsed.cycleSummaries)
      ? parsed.cycleSummaries
          .map((entry) => normalizeRunCycleSummary(entry))
          .filter((entry): entry is RunCycleSummary => entry !== undefined)
      : [],
  };
}

function normalizeState(state: unknown): SessionState {
  if (!state || typeof state !== "object") {
    return { ...DEFAULT_SESSION_STATE, updatedAt: new Date().toISOString() };
  }

  const value = state as Partial<SessionState>;
  const mode = value.mode === "interactive" || value.mode === "run" ? value.mode : "neutral";
  const updatedAt =
    typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString();

  return {
    mode,
    scope: normalizeScope(value.scope),
    updatedAt,
    engagedAt: typeof value.engagedAt === "string" ? value.engagedAt : undefined,
    prime: normalizePrimeCache(value.prime),
    trackedWorkerIds: normalizeTrackedWorkerIds(value.trackedWorkerIds),
    workerNotices: normalizeWorkerNotices(value.workerNotices),
    runOptions: normalizeRunOptions(value.runOptions),
    lastRunOptions: normalizeRunOptions(value.lastRunOptions),
    recentRunSummary: normalizeRunSummary(value.recentRunSummary),
  };
}

export function resolveSessionStateDir(rootDir: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(rootDir, configuredPath);
}

export function resolveSessionStatePath(baseDir: string, sessionId: string): string {
  return path.join(baseDir, `${sessionId}.json`);
}

export async function loadSessionState(baseDir: string, sessionId: string): Promise<SessionState> {
  try {
    const filePath = resolveSessionStatePath(baseDir, sessionId);
    const raw = await readFile(filePath, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    return {
      ...DEFAULT_SESSION_STATE,
      updatedAt: new Date().toISOString(),
    };
  }
}

export async function saveSessionState(
  baseDir: string,
  sessionId: string,
  state: SessionState,
): Promise<SessionState> {
  const normalized = normalizeState(state);
  const filePath = resolveSessionStatePath(baseDir, sessionId);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");

  return normalized;
}

export async function resetSessionState(baseDir: string, sessionId: string): Promise<SessionState> {
  return saveSessionState(baseDir, sessionId, {
    ...DEFAULT_SESSION_STATE,
    updatedAt: new Date().toISOString(),
  });
}
