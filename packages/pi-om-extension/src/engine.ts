import type { Message } from "@mariozechner/pi-ai";

import type { ObservationAgents } from "./agents.js";
import {
  normalizeRenderedBlock,
  renderObservationEntries,
  renderStoredObservations,
} from "./format.js";
import {
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTINUATION_HINT,
} from "./prompts.js";
import { loadSessionState, saveSessionState } from "./state.js";
import {
  deriveObservationEntries,
  normalizeObservationEntries as normalizeTemporalObservationEntries,
} from "./temporal.js";
import {
  countTokens,
  selectMessageChunk,
  serializeMessage,
  summarizeMessageWindow,
} from "./tokens.js";
import type {
  CursorMode,
  CycleReason,
  ObservationEntry,
  ObservationTriggerDecision,
  ObservationTriggerThresholds,
  ObservationWindowStats,
  OMConfig,
  SessionState,
} from "./types.js";

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
  return normalizeTemporalObservationEntries(cloneObservationEntries(entries));
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

export function ensureToolCallPairing(
  allMessages: Message[],
  selectedMessages: Message[],
): Message[] {
  if (selectedMessages.length === 0) {
    return selectedMessages;
  }

  const startIndex = findMessageIndex(allMessages, selectedMessages[0]!);
  if (startIndex <= 0) {
    return selectedMessages;
  }

  const availableToolCallIds = new Set<string>();
  for (const message of selectedMessages) {
    for (const toolCallId of getAssistantToolCallIds(message)) {
      availableToolCallIds.add(toolCallId);
    }
  }

  const unresolvedToolCallIds = new Set<string>();
  for (const message of selectedMessages) {
    for (const toolCallId of getToolResultCallIds(message)) {
      if (!availableToolCallIds.has(toolCallId)) {
        unresolvedToolCallIds.add(toolCallId);
      }
    }
  }

  if (unresolvedToolCallIds.size === 0) {
    return selectedMessages;
  }

  let earliestRequiredIndex: number | undefined;
  for (let i = startIndex - 1; i >= 0; i -= 1) {
    const toolCallIds = getAssistantToolCallIds(allMessages[i]!);
    const matchesPending = [...toolCallIds].some((toolCallId) =>
      unresolvedToolCallIds.has(toolCallId),
    );
    if (!matchesPending) {
      continue;
    }

    earliestRequiredIndex = i;
    for (const toolCallId of toolCallIds) {
      availableToolCallIds.add(toolCallId);
      unresolvedToolCallIds.delete(toolCallId);
    }

    if (unresolvedToolCallIds.size === 0) {
      break;
    }
  }

  if (earliestRequiredIndex === undefined) {
    return selectedMessages;
  }

  return [...allMessages.slice(earliestRequiredIndex, startIndex), ...selectedMessages];
}

export function preservePreviousAssistantResponse(
  allMessages: Message[],
  selectedMessages: Message[],
): Message[] {
  if (selectedMessages.length === 0) {
    return selectedMessages;
  }

  if (getMessageRole(selectedMessages[0]) !== "user") {
    return selectedMessages;
  }

  const startIndex = findMessageIndex(allMessages, selectedMessages[0]!);
  if (startIndex <= 0) {
    return selectedMessages;
  }

  const previousUnit = getPreviousAssistantResponseUnit(allMessages, startIndex);
  if (previousUnit.length === 0) {
    return selectedMessages;
  }

  return [...previousUnit, ...selectedMessages];
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

/**
 * Published observation snapshot that is safe to inject into prompts, expose in
 * slash-command output, and use for pruning decisions on the next turn.
 * Draft fields are intentionally excluded.
 */
export interface PublishedObservationState {
  observations: string;
  observationEntries?: ObservationEntry[];
  currentTask?: string;
  suggestedResponse?: string;
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

export function getPublishedObservationState(state: SessionState): PublishedObservationState {
  return {
    observations: state.observations,
    observationEntries: cloneObservationEntries(state.observationEntries),
    currentTask: state.currentTask,
    suggestedResponse: state.suggestedResponse,
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

export function getObservationTriggerThresholds(
  config: OMConfig,
  phase: "stage" | "publish",
): ObservationTriggerThresholds {
  if (phase === "stage") {
    return {
      messageTokens: config.observation.stageMessageTokens,
      messageCount: config.observation.stageMessageCount,
      toolResultTokens: config.observation.stageToolResultTokens,
    };
  }

  return {
    messageTokens: config.observation.publishMessageTokens,
    messageCount: config.observation.publishMessageCount,
    toolResultTokens: config.observation.publishToolResultTokens,
  };
}

export function evaluateObservationTrigger(
  stats: ObservationWindowStats,
  thresholds: ObservationTriggerThresholds,
  forceObserve: boolean = false,
): ObservationTriggerDecision {
  const reasons: ObservationTriggerDecision["reasons"] = [];

  if (forceObserve) {
    reasons.push("force");
  }
  if (stats.messageTokens >= thresholds.messageTokens) {
    reasons.push("messageTokens");
  }
  if (stats.messageCount >= thresholds.messageCount) {
    reasons.push("messageCount");
  }
  if (stats.toolResultTokens >= thresholds.toolResultTokens) {
    reasons.push("toolResultTokens");
  }

  return {
    shouldTrigger: reasons.length > 0,
    reasons,
    stats,
    thresholds,
  };
}

export function getObservationChunk(config: OMConfig, messages: Message[]): Message[] {
  return selectMessageChunk(messages, {
    maxMessages: config.observation.maxChunkMessages,
    maxTokens: config.observation.maxChunkMessageTokens,
  });
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

      const stageThresholds = getObservationTriggerThresholds(config, "stage");
      const publishThresholds = getObservationTriggerThresholds(config, "publish");
      const forceObserve = options?.forceObserve ?? false;
      const messagesToObserve = options?.excludeLatestMessage
        ? unobservedWindow.messages.slice(0, -1)
        : unobservedWindow.messages;
      const stageDecision = evaluateObservationTrigger(
        summarizeMessageWindow(messagesToObserve),
        stageThresholds,
        forceObserve,
      );
      debugLog(config, "stage check", {
        sessionId,
        reason: cycleReason,
        ...stageDecision.stats,
        thresholds: stageDecision.thresholds,
        reasons: stageDecision.reasons,
        shouldObserve: stageDecision.shouldTrigger,
      });
      let nextDraft = draftState;
      let observeTriggered = false;
      let reflectTriggered = false;
      let remainingMessages = messagesToObserve;
      let chunkIndex = 0;

      while (remainingMessages.length > 0) {
        const remainingDecision = evaluateObservationTrigger(
          summarizeMessageWindow(remainingMessages),
          stageThresholds,
          forceObserve,
        );

        if (!remainingDecision.shouldTrigger && !observeTriggered) {
          break;
        }

        const chunkMessages = getObservationChunk(config, remainingMessages);
        if (chunkMessages.length === 0) {
          break;
        }

        const chunkStats = summarizeMessageWindow(chunkMessages);
        chunkIndex += 1;
        debugLog(config, "observe chunk", {
          sessionId,
          reason: cycleReason,
          chunkIndex,
          remainingMessages: remainingDecision.stats.messageCount,
          remainingMessageTokens: remainingDecision.stats.messageTokens,
          chunkMessages: chunkStats.messageCount,
          chunkMessageTokens: chunkStats.messageTokens,
          chunkToolResultCount: chunkStats.toolResultCount,
          chunkToolResultTokens: chunkStats.toolResultTokens,
        });

        const serializedMessages = chunkMessages.map(serializeMessage).join("\n\n");
        const observeSignal = config.observation.timeout
          ? AbortSignal.timeout(config.observation.timeout)
          : undefined;
        const observed = await agents.observe(
          {
            existingObservations: nextDraft.observations,
            serializedMessages,
            customInstruction: config.observation.customInstruction,
          },
          { signal: observeSignal },
        );
        observeTriggered = true;
        const observedEntries = normalizeObservationEntries(
          observed.observationEntries ?? deriveObservationEntries(observed.observations),
        );
        if (!observed.observations.trim() && !observedEntries?.length) {
          debugLog(config, "observe chunk returned empty", {
            sessionId,
            reason: cycleReason,
            chunkIndex,
          });
          break;
        }
        let observationEntries = observedEntries
          ? appendObservationEntries(nextDraft.observationEntries, observedEntries)
          : undefined;
        let observations = observedEntries
          ? renderObservationEntries(observationEntries)
          : appendObservations(nextDraft.observations, observed.observations);
        let observationTokens = countTokens(observations);
        let currentTask = observed.currentTask ?? nextDraft.currentTask;
        let suggestedResponse = observed.suggestedResponse ?? nextDraft.suggestedResponse;
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
          const reflectedEntries = normalizeObservationEntries(
            reflected.observationEntries ?? deriveObservationEntries(reflected.observations),
          );
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

        const boundary = chunkMessages.at(-1);
        nextDraft = {
          observations,
          observationEntries,
          observationTokens,
          lastObservedEntryId: getMessageId(boundary) ?? nextDraft.lastObservedEntryId,
          lastObservedTimestamp: getMessageTimestamp(boundary) ?? nextDraft.lastObservedTimestamp,
          currentTask,
          suggestedResponse,
        };
        remainingMessages = remainingMessages.slice(chunkMessages.length);
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
      const publishDecision = evaluateObservationTrigger(
        summarizeMessageWindow(unpublishedWindow.messages),
        publishThresholds,
        forceObserve,
      );
      const shouldPublish =
        publishDraft && hasPendingDraft(nextState) && publishDecision.shouldTrigger;
      debugLog(config, "publish check", {
        sessionId,
        reason: cycleReason,
        ...publishDecision.stats,
        thresholds: publishDecision.thresholds,
        reasons: publishDecision.reasons,
        publishDraft,
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

type StoredObservationContextState = PublishedObservationState;

function normalizeContextSection(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeRenderedBlock(value);
  return normalized || undefined;
}

function buildContextSegment(outerTag: string, innerTag?: string, content?: string): string[] {
  const normalizedContent = normalizeContextSection(content);
  const segment = [`<${outerTag}>`];

  if (!innerTag) {
    segment.push(`</${outerTag}>`);
    return segment;
  }

  segment.push(`<${innerTag}>`);
  if (normalizedContent) {
    segment.push(normalizedContent);
  }
  segment.push(`</${innerTag}>`, `</${outerTag}>`);
  return segment;
}

export function buildStoredObservationSegments(
  state: StoredObservationContextState,
): string[] | undefined {
  const observations = normalizeContextSection(renderStoredObservations(state));
  if (!observations) {
    return undefined;
  }

  return [
    ...buildContextSegment("om-durable", "observations", observations),
    "",
    "<om-active>",
    ...buildContextSegment("om-current-task", "current-task", state.currentTask),
    "",
    ...buildContextSegment("om-suggested-response", "suggested-response", state.suggestedResponse),
    "</om-active>",
  ];
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
export function buildObservationContext(state: PublishedObservationState): string | undefined {
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
    "",
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

function getAssistantToolCallIds(message: Message): string[] {
  if (getMessageRole(message) !== "assistant") {
    return [];
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }

  const ids = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if ((block as { type?: unknown }).type !== "toolCall") {
      continue;
    }

    const rawIds = [(block as { id?: unknown }).id, (block as { toolCallId?: unknown }).toolCallId];
    for (const rawId of rawIds) {
      if (typeof rawId === "string" && rawId.length > 0) {
        ids.add(rawId);
      }
    }
  }

  return [...ids];
}

function getToolResultCallIds(message: Message): string[] {
  const role = getMessageRole(message);
  if (role === "toolResult") {
    const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
    return typeof toolCallId === "string" && toolCallId.length > 0 ? [toolCallId] : [];
  }

  if (role !== "assistant") {
    return [];
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }

  const ids = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if ((block as { type?: unknown }).type !== "toolResult") {
      continue;
    }

    const toolCallId = (block as { toolCallId?: unknown }).toolCallId;
    if (typeof toolCallId === "string" && toolCallId.length > 0) {
      ids.add(toolCallId);
    }
  }

  return [...ids];
}

function getPreviousAssistantResponseUnit(messages: Message[], userStartIndex: number): Message[] {
  const previousIndex = userStartIndex - 1;
  const previous = messages[previousIndex];
  const previousRole = getMessageRole(previous);

  if (previousRole === "assistant") {
    // Plain final assistant responses are the common "save that" case. If the
    // immediately preceding assistant message is instead a tool-call request,
    // do not preserve it without its required tool results.
    return getAssistantToolCallIds(previous!).length === 0 ? [previous!] : [];
  }

  if (previousRole !== "toolResult") {
    return [];
  }

  let resultStartIndex = previousIndex;
  while (resultStartIndex > 0 && getMessageRole(messages[resultStartIndex - 1]) === "toolResult") {
    resultStartIndex -= 1;
  }

  const assistantIndex = resultStartIndex - 1;
  if (assistantIndex < 0 || getMessageRole(messages[assistantIndex]) !== "assistant") {
    return [];
  }

  const assistant = messages[assistantIndex]!;
  const toolCallIds = getAssistantToolCallIds(assistant);
  if (toolCallIds.length === 0) {
    return [];
  }

  const toolCallIdSet = new Set(toolCallIds);
  const resultMessages = messages.slice(resultStartIndex, userStartIndex);
  const resultCallIds = new Set(resultMessages.flatMap((message) => getToolResultCallIds(message)));

  for (const resultCallId of resultCallIds) {
    if (!toolCallIdSet.has(resultCallId)) {
      return [];
    }
  }

  for (const toolCallId of toolCallIds) {
    if (!resultCallIds.has(toolCallId)) {
      return [];
    }
  }

  return [assistant, ...resultMessages];
}

function findMessageIndex(messages: Message[], target: Message): number {
  const byReference = messages.indexOf(target);
  if (byReference >= 0) {
    return byReference;
  }

  const targetId = getMessageId(target);
  if (targetId) {
    return findMessageIndexById(messages, targetId);
  }

  return -1;
}

function getMessageRole(message?: Message): string | undefined {
  return (message as { role?: unknown }).role as string | undefined;
}

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
