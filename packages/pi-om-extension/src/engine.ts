import type { Message } from "@mariozechner/pi-ai";

import type { ObservationAgents } from "./agents.js";
import { renderObservationEntries, renderStoredObservations } from "./format.js";
import {
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTINUATION_HINT,
} from "./prompts.js";
import { loadSessionState, saveSessionState } from "./state.js";
import { countMessageTokens, countTokens, serializeMessage } from "./tokens.js";
import type { CursorMode, CycleReason, ObservationEntry, OMConfig, SessionState } from "./types.js";

export interface UnobservedWindow {
  messages: Message[];
  mode: CursorMode;
}

interface DraftObservationState {
  observations: string;
  observationEntries?: ObservationEntry[];
  observationTokens: number;
  lastObservedEntryId?: string;
  lastObservedTimestamp?: number;
  currentTask?: string;
  suggestedResponse?: string;
}

function debugLog(config: OMConfig, message: string, details?: Record<string, unknown>): void {
  if (!config.debug) return;
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.error(`[om:engine] ${message}${payload}`);
}

function cloneObservationEntries(entries?: ObservationEntry[]): ObservationEntry[] | undefined {
  return entries?.map((entry) => ({
    ...entry,
    temporalAnchors: entry.temporalAnchors?.map((anchor) => ({ ...anchor })),
  }));
}

function normalizeObservationEntries(entries?: ObservationEntry[]): ObservationEntry[] | undefined {
  const normalized = cloneObservationEntries(entries)
    ?.map((entry) => ({
      ...entry,
      date: entry.date.trim(),
      line: entry.line.replace(/\r\n/g, "\n").trim(),
      temporalAnchors: entry.temporalAnchors
        ?.map((anchor) => ({
          ...anchor,
          recordedAt: anchor.recordedAt.trim(),
          originalPhrase: anchor.originalPhrase.trim(),
          referencedStart: anchor.referencedStart?.trim() || undefined,
          referencedEnd: anchor.referencedEnd?.trim() || undefined,
        }))
        .filter((anchor) => anchor.recordedAt && anchor.originalPhrase),
    }))
    .filter((entry) => entry.date && entry.line);

  return normalized?.length ? normalized : undefined;
}

function appendObservationEntries(
  existing?: ObservationEntry[],
  incoming?: ObservationEntry[],
): ObservationEntry[] | undefined {
  const current = normalizeObservationEntries(existing);
  const next = normalizeObservationEntries(incoming);

  if (!next?.length) return current;
  if (!current?.length) return next;

  const merged = cloneObservationEntries(current) ?? [];
  const seen = new Set(current.map((entry) => JSON.stringify(entry)));

  for (const entry of next) {
    const signature = JSON.stringify(entry);
    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    merged.push(entry);
  }

  return merged;
}

function serializeObservationEntries(entries?: ObservationEntry[]): string {
  return JSON.stringify(normalizeObservationEntries(entries) ?? []);
}

/**
 * Core OM engine — stateless functions that operate on config, state, and messages.
 * The extension entry point calls these from pi event handlers.
 */

// ---------------------------------------------------------------------------
// Unobserved window extraction
// ---------------------------------------------------------------------------

export function getUnobservedMessages(
  messages: Message[],
  lastObservedEntryId?: string,
  lastObservedTimestamp?: number,
): UnobservedWindow {
  // No cursor set yet — everything is unobserved
  if (!lastObservedEntryId && typeof lastObservedTimestamp !== "number") {
    return { messages, mode: "none" };
  }

  // Try ID-based cursor first (most reliable)
  if (lastObservedEntryId) {
    const index = findMessageIndexById(messages, lastObservedEntryId);
    if (index >= 0) {
      return { messages: messages.slice(index + 1), mode: "id" };
    }
  }

  // Fallback to timestamp-based cursor
  if (typeof lastObservedTimestamp === "number" && Number.isFinite(lastObservedTimestamp)) {
    const tsIndex = messages.findIndex((m) => {
      const ts = getMessageTimestamp(m);
      return typeof ts === "number" && ts > lastObservedTimestamp;
    });

    if (tsIndex >= 0) {
      return { messages: messages.slice(tsIndex), mode: "timestamp" };
    }

    // All messages are at or before the cursor — nothing new
    const newestTs = messages.reduce<number | undefined>((latest, m) => {
      const ts = getMessageTimestamp(m);
      if (typeof ts !== "number") return latest;
      if (typeof latest !== "number") return ts;
      return ts > latest ? ts : latest;
    }, undefined);

    if (typeof newestTs === "number" && newestTs <= lastObservedTimestamp) {
      return { messages: [], mode: "timestamp" };
    }
  }

  // Last resort — just the most recent message
  const latest = messages.at(-1);
  return {
    messages: latest ? [latest] : [],
    mode: "fallback-latest",
  };
}

export function getMessagesBetweenCursors(
  messages: Message[],
  startEntryId?: string,
  startTimestamp?: number,
  endEntryId?: string,
  endTimestamp?: number,
): UnobservedWindow {
  const afterStart = getUnobservedMessages(messages, startEntryId, startTimestamp);

  return {
    messages: takeMessagesThroughCursor(afterStart.messages, endEntryId, endTimestamp),
    mode: afterStart.mode,
  };
}

function getDraftObservationState(state: SessionState): DraftObservationState {
  return {
    observations: state.draftObservations,
    observationEntries: cloneObservationEntries(
      state.draftObservationEntries ?? state.observationEntries,
    ),
    observationTokens: state.draftObservationTokens,
    lastObservedEntryId: state.draftLastObservedEntryId,
    lastObservedTimestamp: state.draftLastObservedTimestamp,
    currentTask: state.draftCurrentTask,
    suggestedResponse: state.draftSuggestedResponse,
  };
}

function applyDraftObservationState(
  state: SessionState,
  draft: DraftObservationState,
): SessionState {
  return {
    ...state,
    draftObservations: draft.observations,
    draftObservationEntries: cloneObservationEntries(draft.observationEntries),
    draftObservationTokens: draft.observationTokens,
    draftLastObservedEntryId: draft.lastObservedEntryId,
    draftLastObservedTimestamp: draft.lastObservedTimestamp,
    draftCurrentTask: draft.currentTask,
    draftSuggestedResponse: draft.suggestedResponse,
  };
}

export function publishDraftState(state: SessionState): SessionState {
  return {
    ...state,
    observations: state.draftObservations,
    observationEntries: cloneObservationEntries(state.draftObservationEntries),
    observationTokens: state.draftObservationTokens,
    lastObservedEntryId: state.draftLastObservedEntryId,
    lastObservedTimestamp: state.draftLastObservedTimestamp,
    currentTask: state.draftCurrentTask,
    suggestedResponse: state.draftSuggestedResponse,
  };
}

function hasPendingDraft(state: SessionState): boolean {
  return (
    state.draftObservations !== state.observations ||
    serializeObservationEntries(state.draftObservationEntries) !==
      serializeObservationEntries(state.observationEntries) ||
    state.draftObservationTokens !== state.observationTokens ||
    state.draftLastObservedEntryId !== state.lastObservedEntryId ||
    state.draftLastObservedTimestamp !== state.lastObservedTimestamp ||
    state.draftCurrentTask !== state.currentTask ||
    state.draftSuggestedResponse !== state.suggestedResponse
  );
}

// ---------------------------------------------------------------------------
// Observation cycle
// ---------------------------------------------------------------------------

export async function runObservationCycle(
  config: OMConfig,
  agents: ObservationAgents,
  sessionId: string,
  allMessages: Message[],
  inflight: Map<string, Promise<void>>,
  options?: {
    forceObserve?: boolean;
    excludeLatestMessage?: boolean;
    publishDraft?: boolean;
    reason?: CycleReason;
  },
): Promise<void> {
  // Deduplicate concurrent cycles for the same session
  if (inflight.has(sessionId)) {
    await inflight.get(sessionId);
    return;
  }

  const task = (async () => {
    try {
      const cycleReason = options?.reason ?? "turn_end";
      const publishDraft = options?.publishDraft ?? true;
      const state = await loadSessionState(config.storage.stateDir, sessionId);
      const draftState = getDraftObservationState(state);
      const unobservedWindow = getUnobservedMessages(
        allMessages,
        draftState.lastObservedEntryId,
        draftState.lastObservedTimestamp,
      );

      const cycleBaseState = {
        lastCycleAt: Date.now(),
        lastCycleReason: cycleReason,
        lastCursorMode: unobservedWindow.mode,
      };

      const messagesToObserve = options?.excludeLatestMessage
        ? unobservedWindow.messages.slice(0, -1)
        : unobservedWindow.messages;

      const unobservedTokens = countMessageTokens(messagesToObserve);
      const shouldObserve =
        options?.forceObserve || unobservedTokens >= config.observation.stageMessageTokens;

      debugLog(config, "stage check", {
        sessionId,
        reason: cycleReason,
        unobservedMessages: messagesToObserve.length,
        unobservedTokens,
        threshold: config.observation.stageMessageTokens,
        shouldObserve,
      });

      let nextDraft = draftState;
      let observeTriggered = false;
      let reflectTriggered = false;

      if (messagesToObserve.length > 0 && shouldObserve) {
        // Serialize messages for the observer
        const serializedMessages = messagesToObserve.map(serializeMessage).join("\n\n");

        // Create a timeout signal so a slow/hung LLM call cannot block forever
        const observeSignal = config.observation.timeout
          ? AbortSignal.timeout(config.observation.timeout)
          : undefined;

        const observed = await agents.observe(
          {
            existingObservations: draftState.observations,
            serializedMessages,
            customInstruction: config.observation.customInstruction,
          },
          { signal: observeSignal },
        );

        observeTriggered = true;

        const observedEntries = normalizeObservationEntries(observed.observationEntries);

        if (observed.observations.trim() || observedEntries?.length) {
          let observationEntries = observedEntries
            ? appendObservationEntries(draftState.observationEntries, observedEntries)
            : undefined;
          let observations = observedEntries
            ? renderObservationEntries(observationEntries)
            : appendObservations(draftState.observations, observed.observations);
          let observationTokens = countTokens(observations);
          let currentTask = observed.currentTask ?? draftState.currentTask;
          let suggestedResponse = observed.suggestedResponse ?? draftState.suggestedResponse;

          // Trigger reflection if observation block is too large
          if (observationTokens >= config.reflection.observationTokens) {
            reflectTriggered = true;
            debugLog(config, "reflection triggered", {
              sessionId,
              observationTokens,
              threshold: config.reflection.observationTokens,
            });

            const reflectSignal = config.reflection.timeout
              ? AbortSignal.timeout(config.reflection.timeout)
              : undefined;

            const reflected = await agents.reflect(
              {
                observations,
                customInstruction: config.reflection.customInstruction,
              },
              { signal: reflectSignal },
            );

            const reflectedEntries = normalizeObservationEntries(reflected.observationEntries);

            if (reflectedEntries) {
              observationEntries = reflectedEntries;
              observations = renderObservationEntries(observationEntries);
              observationTokens = countTokens(observations);
            } else if (reflected.observations.trim()) {
              observationEntries = undefined;
              observations = reflected.observations;
              observationTokens = countTokens(observations);
            }

            if (reflected.currentTask) {
              currentTask = reflected.currentTask;
            }
            if (reflected.suggestedResponse) {
              suggestedResponse = reflected.suggestedResponse;
            }
          }

          // Update cursor to the last observed message
          const boundary = messagesToObserve.at(-1);
          nextDraft = {
            observations,
            observationEntries,
            observationTokens,
            lastObservedEntryId: getMessageId(boundary) ?? draftState.lastObservedEntryId,
            lastObservedTimestamp:
              getMessageTimestamp(boundary) ?? draftState.lastObservedTimestamp,
            currentTask,
            suggestedResponse,
          };
        }
      }

      if (cycleReason === "context" && !observeTriggered) {
        return;
      }

      let nextState = applyDraftObservationState(
        {
          ...state,
          ...cycleBaseState,
          observeTriggered,
          publishTriggered: false,
          reflectTriggered,
        },
        nextDraft,
      );

      const unpublishedWindow = getMessagesBetweenCursors(
        allMessages,
        state.lastObservedEntryId,
        state.lastObservedTimestamp,
        nextDraft.lastObservedEntryId,
        nextDraft.lastObservedTimestamp,
      );
      const unpublishedTokens = countMessageTokens(unpublishedWindow.messages);
      const shouldPublish =
        publishDraft &&
        hasPendingDraft(nextState) &&
        (options?.forceObserve || unpublishedTokens >= config.observation.publishMessageTokens);

      debugLog(config, "publish check", {
        sessionId,
        reason: cycleReason,
        unpublishedMessages: unpublishedWindow.messages.length,
        unpublishedTokens,
        threshold: config.observation.publishMessageTokens,
        shouldPublish,
      });

      nextState = {
        ...nextState,
        publishTriggered: shouldPublish,
      };

      await saveSessionState(
        config.storage.stateDir,
        shouldPublish ? publishDraftState(nextState) : nextState,
      );
    } catch (error) {
      // Always log observation failures — these are operational errors, not debug traces
      console.error(
        "[om:engine] observation cycle failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  })().finally(() => {
    inflight.delete(sessionId);
  });

  inflight.set(sessionId, task);
  await task;
}

// ---------------------------------------------------------------------------
// Context building (injected into system prompt area)
// ---------------------------------------------------------------------------

type StoredObservationContextState = Pick<
  SessionState,
  "observations" | "observationEntries" | "currentTask" | "suggestedResponse"
>;

export function buildStoredObservationSegments(
  state: StoredObservationContextState,
): string[] | undefined {
  const observations = renderStoredObservations(state);
  if (!observations) {
    return undefined;
  }

  const sections = [
    "<om-durable>",
    "<observations>",
    observations,
    "</observations>",
    "</om-durable>",
  ];

  sections.push("", "<om-active>");
  if (state.currentTask) {
    sections.push("<current-task>", state.currentTask, "</current-task>");
  }
  if (state.suggestedResponse) {
    if (state.currentTask) {
      sections.push("");
    }
    sections.push("<suggested-response>", state.suggestedResponse, "</suggested-response>");
  }

  sections.push("</om-active>");

  return sections;
}

export function buildStoredObservationBlock(
  state: StoredObservationContextState,
): string | undefined {
  const segments = buildStoredObservationSegments(state);
  if (!segments) {
    return undefined;
  }

  return ["<observational-memory>", ...segments, "</observational-memory>"].join("\n");
}
export function buildObservationContext(state: SessionState): string | undefined {
  const segments = buildStoredObservationSegments(state);
  if (!segments) {
    return undefined;
  }
  const sections = [
    OBSERVATION_CONTEXT_PROMPT,
    "",
    "<observational-memory>",
    ...segments,
    "",
    "<om-guidance>",
    "<memory-instructions>",
    OBSERVATION_CONTEXT_INSTRUCTIONS,
    "</memory-instructions>",
    buildContinuationReminder(),
    "</om-guidance>",
    "</observational-memory>",
  ];
  return sections.join("\n");
}
export function buildContinuationReminder(): string {
  return `<system-reminder>${OBSERVATION_CONTINUATION_HINT}</system-reminder>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function appendObservations(existing: string, incoming: string): string {
  const current = normalizeObservations(existing);
  const next = normalizeObservations(incoming);

  if (!next) return current;
  if (!current) return next;
  if (current === next) return current;
  if (next.includes(current)) return next;
  if (current.includes(next)) return current;

  return `${current}\n\n${next}`;
}

function normalizeObservations(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function takeMessagesThroughCursor(
  messages: Message[],
  lastObservedEntryId?: string,
  lastObservedTimestamp?: number,
): Message[] {
  if (messages.length === 0) return [];
  if (!lastObservedEntryId && typeof lastObservedTimestamp !== "number") return [];

  if (lastObservedEntryId) {
    const index = findMessageIndexById(messages, lastObservedEntryId);
    if (index >= 0) {
      return messages.slice(0, index + 1);
    }
  }

  if (typeof lastObservedTimestamp === "number" && Number.isFinite(lastObservedTimestamp)) {
    let lastIndexAtOrBeforeTimestamp = -1;

    for (let i = 0; i < messages.length; i += 1) {
      const ts = getMessageTimestamp(messages[i]);
      if (typeof ts === "number" && ts <= lastObservedTimestamp) {
        lastIndexAtOrBeforeTimestamp = i;
      }
    }

    if (lastIndexAtOrBeforeTimestamp >= 0) {
      return messages.slice(0, lastIndexAtOrBeforeTimestamp + 1);
    }
  }

  return [];
}

function getMessageTimestamp(message?: Message): number | undefined {
  if (!message) return undefined;
  const ts = (message as { timestamp?: unknown }).timestamp;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
}

/**
 * In pi, messages in the context event don't have a stable ID field on
 * the Message type itself. But session entries (which the messages come from)
 * do have IDs. We attempt to read it from a potential `id` property if present.
 */
function getMessageId(message?: Message): string | undefined {
  if (!message) return undefined;
  const maybeId = (message as { id?: unknown }).id;
  if (typeof maybeId === "string" && maybeId.length > 0) return maybeId;
  return undefined;
}

/**
 * Find a message by ID. Since pi-ai Messages don't have a native ID field,
 * this checks for an `id` property that may be attached by the session manager.
 */
function findMessageIndexById(messages: Message[], id: string): number {
  return messages.findIndex((m) => {
    const maybeId = (m as { id?: unknown }).id;
    return typeof maybeId === "string" && maybeId === id;
  });
}
