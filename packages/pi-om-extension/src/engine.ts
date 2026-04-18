import type { Message } from "@mariozechner/pi-ai";

import type { ObservationAgents } from "./agents.js";
import {
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTINUATION_HINT,
} from "./prompts.js";
import { loadSessionState, saveSessionState } from "./state.js";
import { countMessageTokens, countTokens, serializeMessage } from "./tokens.js";
import type { CursorMode, CycleReason, OMConfig, SessionState } from "./types.js";

export interface UnobservedWindow {
  messages: Message[];
  mode: CursorMode;
}

interface DraftObservationState {
  observations: string;
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

function getDraftObservationState(state: SessionState): DraftObservationState {
  return {
    observations: state.draftObservations,
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
    observationTokens: state.draftObservationTokens,
    lastObservedEntryId: state.draftLastObservedEntryId,
    lastObservedTimestamp: state.draftLastObservedTimestamp,
    currentTask: state.draftCurrentTask,
    suggestedResponse: state.draftSuggestedResponse,
  };
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

      if (messagesToObserve.length === 0) {
        if (cycleReason !== "context") {
          const nextState = {
            ...state,
            ...cycleBaseState,
            observeTriggered: false,
            reflectTriggered: false,
          };
          await saveSessionState(
            config.storage.stateDir,
            publishDraft ? publishDraftState(nextState) : nextState,
          );
        }
        return;
      }

      const unobservedTokens = countMessageTokens(messagesToObserve);
      const shouldObserve =
        options?.forceObserve || unobservedTokens >= config.observation.messageTokens;

      debugLog(config, "cycle check", {
        sessionId,
        reason: cycleReason,
        unobservedMessages: messagesToObserve.length,
        unobservedTokens,
        threshold: config.observation.messageTokens,
        shouldObserve,
      });

      if (!shouldObserve) {
        if (cycleReason !== "context") {
          const nextState = {
            ...state,
            ...cycleBaseState,
            observeTriggered: false,
            reflectTriggered: false,
          };
          await saveSessionState(
            config.storage.stateDir,
            publishDraft ? publishDraftState(nextState) : nextState,
          );
        }
        return;
      }

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

      if (!observed.observations.trim()) {
        const nextState = {
          ...state,
          ...cycleBaseState,
          observeTriggered: true,
          reflectTriggered: false,
        };
        await saveSessionState(
          config.storage.stateDir,
          publishDraft ? publishDraftState(nextState) : nextState,
        );
        return;
      }

      let observations = appendObservations(draftState.observations, observed.observations);
      let observationTokens = countTokens(observations);
      let currentTask = observed.currentTask ?? draftState.currentTask;
      let suggestedResponse = observed.suggestedResponse ?? draftState.suggestedResponse;
      let reflectTriggered = false;

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

        if (reflected.observations.trim()) {
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

      const nextState = applyDraftObservationState(
        {
          ...state,
          ...cycleBaseState,
          observeTriggered: true,
          reflectTriggered,
        },
        {
          observations,
          observationTokens,
          lastObservedEntryId: getMessageId(boundary) ?? draftState.lastObservedEntryId,
          lastObservedTimestamp: getMessageTimestamp(boundary) ?? draftState.lastObservedTimestamp,
          currentTask,
          suggestedResponse,
        },
      );

      await saveSessionState(
        config.storage.stateDir,
        publishDraft ? publishDraftState(nextState) : nextState,
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

export function buildObservationContext(state: SessionState): string | undefined {
  if (!state.observations.trim()) {
    return undefined;
  }

  const sections = [
    OBSERVATION_CONTEXT_PROMPT,
    "",
    "<observations>",
    state.observations,
    "</observations>",
  ];

  if (state.currentTask) {
    sections.push("", "<current-task>", state.currentTask, "</current-task>");
  }

  if (state.suggestedResponse) {
    sections.push("", "<suggested-response>", state.suggestedResponse, "</suggested-response>");
  }

  sections.push("", OBSERVATION_CONTEXT_INSTRUCTIONS);

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
