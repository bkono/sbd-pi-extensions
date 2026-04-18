import { readFile, writeFile } from "node:fs/promises";

import { ensureParentDirectory, sessionStatePath } from "./config.js";
import type {
  CursorMode,
  ObservationEntry,
  SessionState,
  TemporalAnchor,
  TemporalAnchorPrecision,
  TemporalAnchorRelation,
} from "./types.js";

function debugLog(message: string, details?: Record<string, unknown>): void {
  if (process.env.OM_DEBUG !== "1") return;
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.error(`[om:state] ${message}${payload}`);
}

const VALID_CURSOR_MODES: ReadonlySet<CursorMode> = new Set([
  "none",
  "id",
  "timestamp",
  "fallback-latest",
]);

const VALID_TEMPORAL_PRECISIONS: ReadonlySet<TemporalAnchorPrecision> = new Set([
  "exact",
  "day",
  "week",
  "month",
  "approximate",
]);

const VALID_TEMPORAL_RELATIONS: ReadonlySet<TemporalAnchorRelation> = new Set([
  "past",
  "current",
  "future",
  "ongoing",
]);

export function createDefaultState(sessionId: string): SessionState {
  return {
    sessionId,
    observations: "",
    observationTokens: 0,
    draftObservations: "",
    draftObservationTokens: 0,
    updatedAt: Date.now(),
  };
}

function cloneTemporalAnchor(anchor: TemporalAnchor): TemporalAnchor {
  return { ...anchor };
}

function cloneObservationEntry(entry: ObservationEntry): ObservationEntry {
  return {
    ...entry,
    temporalAnchors: entry.temporalAnchors?.map(cloneTemporalAnchor),
  };
}

function parseTemporalAnchor(raw: unknown): TemporalAnchor | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;
  const recordedAt = typeof obj.recordedAt === "string" ? obj.recordedAt.trim() : "";
  const originalPhrase = typeof obj.originalPhrase === "string" ? obj.originalPhrase.trim() : "";
  const referencedStart =
    typeof obj.referencedStart === "string" ? obj.referencedStart.trim() : undefined;
  const referencedEnd =
    typeof obj.referencedEnd === "string" ? obj.referencedEnd.trim() : undefined;
  const precision =
    typeof obj.precision === "string" &&
    VALID_TEMPORAL_PRECISIONS.has(obj.precision as TemporalAnchorPrecision)
      ? (obj.precision as TemporalAnchorPrecision)
      : undefined;
  const relation =
    typeof obj.relation === "string" &&
    VALID_TEMPORAL_RELATIONS.has(obj.relation as TemporalAnchorRelation)
      ? (obj.relation as TemporalAnchorRelation)
      : undefined;

  if (!recordedAt || !originalPhrase || !precision || !relation) {
    return undefined;
  }

  return {
    recordedAt,
    originalPhrase,
    referencedStart: referencedStart || undefined,
    referencedEnd: referencedEnd || undefined,
    precision,
    relation,
  };
}

function parseObservationEntries(raw: unknown): ObservationEntry[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const entries = raw
    .map((entry): ObservationEntry | undefined => {
      if (entry === null || typeof entry !== "object") {
        return undefined;
      }

      const obj = entry as Record<string, unknown>;
      const date = typeof obj.date === "string" ? obj.date.trim() : "";
      const line = typeof obj.line === "string" ? obj.line.replace(/\r\n/g, "\n").trim() : "";
      const temporalAnchors = Array.isArray(obj.temporalAnchors)
        ? obj.temporalAnchors
            .map(parseTemporalAnchor)
            .filter((anchor): anchor is TemporalAnchor => !!anchor)
        : undefined;

      if (!date || !line) {
        return undefined;
      }

      return {
        date,
        line,
        temporalAnchors: temporalAnchors?.length ? temporalAnchors : undefined,
      };
    })
    .filter((entry): entry is ObservationEntry => !!entry);

  return entries.map(cloneObservationEntry);
}

function validateState(raw: unknown, sessionId: string): SessionState {
  const state = createDefaultState(sessionId);

  if (raw === null || typeof raw !== "object") {
    return state;
  }

  const obj = raw as Record<string, unknown>;

  // sessionId — always use the requested one, ignore whatever is on disk
  state.sessionId = sessionId;

  if (typeof obj.observations === "string") {
    state.observations = obj.observations;
  }

  const observationEntries = parseObservationEntries(obj.observationEntries);
  if (observationEntries) {
    state.observationEntries = observationEntries;
  }

  if (typeof obj.observationTokens === "number" && Number.isFinite(obj.observationTokens)) {
    state.observationTokens = obj.observationTokens;
  }

  if (typeof obj.lastObservedEntryId === "string") {
    state.lastObservedEntryId = obj.lastObservedEntryId;
  }

  if (typeof obj.lastObservedTimestamp === "number" && Number.isFinite(obj.lastObservedTimestamp)) {
    state.lastObservedTimestamp = obj.lastObservedTimestamp;
  }

  if (typeof obj.currentTask === "string") {
    state.currentTask = obj.currentTask;
  }

  if (typeof obj.suggestedResponse === "string") {
    state.suggestedResponse = obj.suggestedResponse;
  }

  if (typeof obj.draftObservations === "string") {
    state.draftObservations = obj.draftObservations;
  } else {
    state.draftObservations = state.observations;
  }

  const draftObservationEntries = parseObservationEntries(obj.draftObservationEntries);
  if (draftObservationEntries) {
    state.draftObservationEntries = draftObservationEntries;
  } else if (state.observationEntries) {
    state.draftObservationEntries = state.observationEntries.map(cloneObservationEntry);
  }

  if (
    typeof obj.draftObservationTokens === "number" &&
    Number.isFinite(obj.draftObservationTokens)
  ) {
    state.draftObservationTokens = obj.draftObservationTokens;
  } else {
    state.draftObservationTokens = state.observationTokens;
  }

  if (typeof obj.draftLastObservedEntryId === "string") {
    state.draftLastObservedEntryId = obj.draftLastObservedEntryId;
  } else if (typeof state.lastObservedEntryId === "string") {
    state.draftLastObservedEntryId = state.lastObservedEntryId;
  }

  if (
    typeof obj.draftLastObservedTimestamp === "number" &&
    Number.isFinite(obj.draftLastObservedTimestamp)
  ) {
    state.draftLastObservedTimestamp = obj.draftLastObservedTimestamp;
  } else if (typeof state.lastObservedTimestamp === "number") {
    state.draftLastObservedTimestamp = state.lastObservedTimestamp;
  }

  if (typeof obj.draftCurrentTask === "string") {
    state.draftCurrentTask = obj.draftCurrentTask;
  } else if (typeof state.currentTask === "string") {
    state.draftCurrentTask = state.currentTask;
  }

  if (typeof obj.draftSuggestedResponse === "string") {
    state.draftSuggestedResponse = obj.draftSuggestedResponse;
  } else if (typeof state.suggestedResponse === "string") {
    state.draftSuggestedResponse = state.suggestedResponse;
  }

  if (typeof obj.lastCycleAt === "number" && Number.isFinite(obj.lastCycleAt)) {
    state.lastCycleAt = obj.lastCycleAt;
  }

  if (typeof obj.lastCycleReason === "string") {
    state.lastCycleReason = obj.lastCycleReason;
  }

  if (
    typeof obj.lastCursorMode === "string" &&
    VALID_CURSOR_MODES.has(obj.lastCursorMode as CursorMode)
  ) {
    state.lastCursorMode = obj.lastCursorMode as CursorMode;
  }

  if (
    typeof obj.tailEntriesBeforePrune === "number" &&
    Number.isFinite(obj.tailEntriesBeforePrune)
  ) {
    state.tailEntriesBeforePrune = obj.tailEntriesBeforePrune;
  }

  if (typeof obj.tailTokensBeforePrune === "number" && Number.isFinite(obj.tailTokensBeforePrune)) {
    state.tailTokensBeforePrune = obj.tailTokensBeforePrune;
  }

  if (typeof obj.tailEntriesAfterPrune === "number" && Number.isFinite(obj.tailEntriesAfterPrune)) {
    state.tailEntriesAfterPrune = obj.tailEntriesAfterPrune;
  }

  if (typeof obj.tailTokensAfterPrune === "number" && Number.isFinite(obj.tailTokensAfterPrune)) {
    state.tailTokensAfterPrune = obj.tailTokensAfterPrune;
  }

  if (typeof obj.observeTriggered === "boolean") {
    state.observeTriggered = obj.observeTriggered;
  }

  if (typeof obj.publishTriggered === "boolean") {
    state.publishTriggered = obj.publishTriggered;
  }

  if (typeof obj.reflectTriggered === "boolean") {
    state.reflectTriggered = obj.reflectTriggered;
  }

  if (typeof obj.prunedEntriesCount === "number" && Number.isFinite(obj.prunedEntriesCount)) {
    state.prunedEntriesCount = obj.prunedEntriesCount;
  }

  if (typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt)) {
    state.updatedAt = obj.updatedAt;
  }

  return state;
}

export async function loadSessionState(stateDir: string, sessionId: string): Promise<SessionState> {
  const path = sessionStatePath(stateDir, sessionId);

  try {
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const state = validateState(parsed, sessionId);
    debugLog("loaded session state", { sessionId, path });
    return state;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      debugLog("failed to load session state, using defaults", {
        sessionId,
        path,
        error: String(err),
      });
    }
    return createDefaultState(sessionId);
  }
}

export async function saveSessionState(stateDir: string, state: SessionState): Promise<void> {
  state.updatedAt = Date.now();

  const path = sessionStatePath(stateDir, state.sessionId);
  await ensureParentDirectory(path);
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
  debugLog("saved session state", { sessionId: state.sessionId, path });
}
