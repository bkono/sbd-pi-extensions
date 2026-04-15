import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SESSION_STATE } from "./constants.js";
import type { PrimeCache, SessionScope, SessionState } from "./types.js";

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
