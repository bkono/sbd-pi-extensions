import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SESSION_STATE } from "./constants.js";
import {
  type Goal,
  isV1Goal,
  type PrimeCache,
  type ReviewPolicy,
  type SessionScope,
  type SessionState,
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

function normalizeReviewPolicy(value: unknown): ReviewPolicy | undefined {
  return value === "ticket" || value === "scope" || value === "none" ? value : undefined;
}

function normalizeGoal(value: unknown): Goal | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const parsed = value as Partial<Goal>;
  if (typeof parsed.goalId !== "string" || parsed.goalId.length === 0) {
    return undefined;
  }

  const scopeIds = Array.isArray(parsed.scopeIds)
    ? parsed.scopeIds.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : [];
  const reviewPolicy = normalizeReviewPolicy(parsed.reviewPolicy);
  const startedAt =
    typeof parsed.startedAt === "string" && parsed.startedAt.length > 0
      ? parsed.startedAt
      : undefined;

  if (!reviewPolicy || !startedAt) {
    return undefined;
  }

  const goal: Goal = {
    goalId: parsed.goalId,
    scopeIds,
    reviewPolicy,
    startedAt,
  };

  return isV1Goal(goal) ? goal : undefined;
}

export function isInterruptedRun(state: SessionState): boolean {
  return state.mode === "run" && state.runInterrupted === true;
}

/** Drop goal mode while retaining interactive scope and cached prime guidance. */
export function dropGoalMode(state: SessionState, now = new Date().toISOString()): SessionState {
  return {
    ...state,
    mode: "interactive",
    updatedAt: now,
    goal: undefined,
    runInterrupted: undefined,
  };
}

function normalizeState(state: unknown, origin: "memory" | "disk" = "memory"): SessionState {
  if (!state || typeof state !== "object") {
    return { ...DEFAULT_SESSION_STATE, updatedAt: new Date().toISOString() };
  }

  const value = state as Record<string, unknown>;
  const mode = value.mode === "interactive" || value.mode === "run" ? value.mode : "neutral";
  const updatedAt =
    typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString();
  // A persisted goal requires an explicit resume. Runtime fleet state belongs to orchestration and is
  // deliberately neither restored nor projected into this schema.
  const interruptedRun = mode === "run" && (origin === "disk" || value.runInterrupted === true);

  return {
    mode,
    scope: normalizeScope(value.scope),
    updatedAt,
    engagedAt: typeof value.engagedAt === "string" ? value.engagedAt : undefined,
    prime: normalizePrimeCache(value.prime),
    goal: normalizeGoal(value.goal),
    runInterrupted: interruptedRun ? true : undefined,
  };
}

function toPersistedSessionState(state: SessionState): SessionState {
  return {
    mode: state.mode,
    scope: state.scope,
    updatedAt: state.updatedAt,
    engagedAt: state.engagedAt,
    prime: state.prime,
    goal: state.goal,
    runInterrupted: state.mode === "run" && state.runInterrupted === true ? true : undefined,
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
    return normalizeState(JSON.parse(raw), "disk");
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
  const normalized = normalizeState(state, "memory");
  const filePath = resolveSessionStatePath(baseDir, sessionId);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(toPersistedSessionState(normalized), null, 2)}\n`,
    "utf8",
  );

  return normalized;
}

export async function resetSessionState(baseDir: string, sessionId: string): Promise<SessionState> {
  return saveSessionState(baseDir, sessionId, {
    ...DEFAULT_SESSION_STATE,
    updatedAt: new Date().toISOString(),
  });
}
