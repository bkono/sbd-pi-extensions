import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { ResolvedOMConfig } from "./config.js";
import type { ChunkData, OMState } from "./state.js";
import { isObservableMessage } from "./transcript.js";

/**
 * One context-producing session entry as the model sees it. This is the Pi analogue of a
 * Mastra message: entry ids are stable, so coverage is by id, never by timestamp.
 */
export interface ContextUnit {
  entryId: string;
  messages: AgentMessage[];
  tokens: number;
  /** Whether the observer should ever see it (summaries and excluded bash are not). */
  observable: boolean;
  /** Whether the model has already seen this entry (see `units` in runtime.ts). */
  read: boolean;
  /** Role of the first message. */
  role: string;
  toolCallIds: string[];
  toolResultIds: string[];
}

/** Message roles Pi accepts a `context_edit` for (session-manager appendContextEdit). */
const EDITABLE_ROLES = new Set(["user", "assistant", "toolResult", "custom"]);

export function describeUnit(
  entryId: string,
  entryType: string,
  messages: AgentMessage[],
  tokens: number,
  read: boolean,
): ContextUnit {
  const toolCallIds: string[] = [];
  const toolResultIds: string[] = [];
  for (const message of messages) {
    const m = message as {
      role?: string;
      content?: unknown;
      toolCallId?: unknown;
      stopReason?: unknown;
    };
    // Pi never writes results for calls on an aborted or failed response, and drops those
    // messages from provider context, so their calls must not hold the safe prefix open.
    const deadResponse = m.stopReason === "aborted" || m.stopReason === "error";
    if (m.role === "assistant" && Array.isArray(m.content) && !deadResponse) {
      for (const block of m.content as { type?: string; id?: unknown }[]) {
        if (block?.type === "toolCall" && typeof block.id === "string") toolCallIds.push(block.id);
      }
    }
    if (m.role === "toolResult" && typeof m.toolCallId === "string")
      toolResultIds.push(m.toolCallId);
  }
  const role = (messages[0] as { role?: string } | undefined)?.role ?? "";
  // Only entries Pi can omit with a context edit may ever be covered by a chunk; anything
  // else (a `!cmd` bash entry, summaries) stays raw in context.
  const editable =
    (entryType === "message" || entryType === "custom_message") &&
    messages.every((message) => EDITABLE_ROLES.has((message as { role?: string }).role ?? ""));
  return {
    entryId,
    messages,
    tokens,
    observable: messages.length > 0 && editable && messages.every(isObservableMessage),
    read,
    role,
    toolCallIds,
    toolResultIds,
  };
}

export interface OMStatus {
  /** Unobserved observable message tokens in context (buffered or not). */
  pendingTokens: number;
  /** Pending tokens not covered by a buffered chunk. */
  unbufferedTokens: number;
  unobserved: ContextUnit[];
  unbuffered: ContextUnit[];
  threshold: number;
  blockAfter: number;
  shouldObserve: boolean;
  /** threshold <= pending < blockAfter: activate if a chunk is ready, never block. */
  inBand: boolean;
  /** pending >= blockAfter: the only state that may block. */
  mustBlock: boolean;
  canActivate: boolean;
  observationTokens: number;
}

export function computeStatus(
  units: readonly ContextUnit[],
  state: OMState,
  config: ResolvedOMConfig,
): OMStatus {
  const unobserved = units.filter(
    (unit) => unit.observable && !state.observedEntryIds.has(unit.entryId),
  );
  const liveBuffered = new Set(liveBufferedChunks(state, units).flatMap((chunk) => chunk.entryIds));
  const unbuffered = unobserved.filter((unit) => !liveBuffered.has(unit.entryId));
  const pendingTokens = sum(unobserved);
  const unbufferedTokens = sum(unbuffered);
  const threshold = config.messageTokens;
  const blockAfter = config.observationBlockAfter;
  return {
    pendingTokens,
    unbufferedTokens,
    unobserved,
    unbuffered,
    threshold,
    blockAfter,
    shouldObserve: pendingTokens >= threshold,
    inBand: pendingTokens >= threshold && pendingTokens < blockAfter,
    mustBlock: pendingTokens >= blockAfter,
    canActivate: activatableChunks(state, units).length > 0,
    observationTokens: state.observationTokens,
  };
}

function sum(units: readonly ContextUnit[]): number {
  return units.reduce((total, unit) => total + unit.tokens, 0);
}

/**
 * Whether a new background observation should start. Mastra triggers on crossing a
 * `bufferTokens` interval, halving the interval near the threshold. Here the interval is
 * measured on unbuffered tokens, which is equivalent and needs no persisted boundary.
 */
export function shouldBuffer(status: OMStatus, config: ResolvedOMConfig): boolean {
  if (status.mustBlock) return false;
  if (status.unbuffered.length === 0) return false;
  const rampPoint = config.messageTokens - config.bufferTokens * 1.1;
  const interval =
    status.pendingTokens >= rampPoint ? config.bufferTokens / 2 : config.bufferTokens;
  if (status.unbufferedTokens >= interval) return true;
  // In the band with nothing ready, buffer whatever exists so activation has something.
  return status.inBand && !status.canActivate;
}

/**
 * The longest prefix of units that does not split a tool exchange: every tool call in the
 * prefix has its result in the prefix, and no result in the prefix lacks its call.
 */
export function selectSafePrefix(units: readonly ContextUnit[]): ContextUnit[] {
  const openCalls = new Set<string>();
  let safeLength = 0;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]!;
    // Once the conversation moves on (a new user or assistant message), calls still open
    // are orphans: Pi will never pair them, so they must not block the prefix (Mastra
    // selectSafeBufferPrefix treats only the newest pending call as live).
    if (unit.role === "user" || unit.role === "assistant") openCalls.clear();
    for (const id of unit.toolCallIds) openCalls.add(id);
    for (const id of unit.toolResultIds) openCalls.delete(id);
    if (openCalls.size === 0) safeLength = index + 1;
  }
  return units.slice(0, safeLength);
}

/**
 * Buffered chunks still valid for this context: every entry they cover is in context and
 * observable. A chunk that lost an entry (Pi omitted a retried error response, another
 * extension edited it out, a compaction cut through it, or it was computed on another
 * branch) is stale. Its remaining entries count as unbuffered again and get re-observed,
 * so nothing is stranded.
 */
export function liveBufferedChunks(state: OMState, units: readonly ContextUnit[]): ChunkData[] {
  const observable = new Set(units.filter((unit) => unit.observable).map((unit) => unit.entryId));
  return state.buffered.filter((chunk) => chunk.entryIds.every((id) => observable.has(id)));
}

/** Live buffered chunks, in order, up to the first one that covers an unread entry. */
export function activatableChunks(state: OMState, units: readonly ContextUnit[]): ChunkData[] {
  const unread = new Set(units.filter((unit) => !unit.read).map((unit) => unit.entryId));
  const ready: ChunkData[] = [];
  for (const chunk of liveBufferedChunks(state, units)) {
    if (chunk.entryIds.some((id) => unread.has(id))) break;
    ready.push(chunk);
  }
  return ready;
}

/**
 * How many leading chunks to activate. Port of Mastra `calculateProjectedMessageRemoval`:
 * remove down to the retention floor at a chunk boundary, biased toward removing slightly
 * more, with the same overshoot safeguards.
 */
export function selectActivationCount(
  chunks: readonly ChunkData[],
  pendingTokens: number,
  retentionFloor: number,
): number {
  if (chunks.length === 0) return 0;
  const target = Math.max(0, pendingTokens - retentionFloor);
  if (target === 0) return 0;

  let cumulative = 0;
  let bestOver = 0;
  let bestOverTokens = 0;
  let bestUnder = 0;
  let bestUnderTokens = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    cumulative += chunks[index]!.messageTokens;
    const boundary = index + 1;
    if (cumulative >= target) {
      if (bestOver === 0 || cumulative < bestOverTokens) {
        bestOver = boundary;
        bestOverTokens = cumulative;
      }
    } else if (cumulative > bestUnderTokens) {
      bestUnder = boundary;
      bestUnderTokens = cumulative;
    }
  }

  const maxOvershoot = retentionFloor * 0.95;
  const overshoot = bestOverTokens - target;
  const minRemaining = Math.min(1_000, retentionFloor);
  if (bestOver > 0 && overshoot <= maxOvershoot && pendingTokens - bestOverTokens >= minRemaining) {
    return bestOver;
  }
  if (bestUnder > 0 && pendingTokens - bestUnderTokens >= minRemaining) return bestUnder;
  if (bestOver > 0) return bestOver;
  return 1;
}

export type ReflectionDecision =
  | { kind: "none" }
  | { kind: "start-buffer" }
  | { kind: "activate-buffer" }
  | { kind: "sync" };

/**
 * Mastra reflection policy: buffer in the background from `reflectionBufferAt`, swap the
 * buffered reflection in at the threshold, and block only at `reflectionBlockAfter`.
 */
export function decideReflection(input: {
  observationTokens: number;
  hasBufferedReflection: boolean;
  reflectionInFlight: boolean;
  config: ResolvedOMConfig;
}): ReflectionDecision {
  const { observationTokens, hasBufferedReflection, reflectionInFlight, config } = input;
  if (observationTokens >= config.reflectionTokens) {
    if (hasBufferedReflection) return { kind: "activate-buffer" };
    if (observationTokens >= config.reflectionBlockAfter) return { kind: "sync" };
    if (!reflectionInFlight) return { kind: "start-buffer" };
    return { kind: "none" };
  }
  if (
    observationTokens >= config.reflectionBufferAt &&
    !hasBufferedReflection &&
    !reflectionInFlight
  ) {
    return { kind: "start-buffer" };
  }
  return { kind: "none" };
}

/** The oldest active items whose tokens reach `budget`, used as the buffered reflection slice. */
export function selectReflectionSlice(
  state: OMState,
  budget: number,
): {
  includeReflection: boolean;
  chunkIds: string[];
  tokens: number;
} {
  let tokens = state.reflection?.observationTokens ?? 0;
  const chunkIds: string[] = [];
  for (const chunk of state.activeChunks) {
    if (tokens >= budget && chunkIds.length > 0) break;
    chunkIds.push(chunk.id);
    tokens += chunk.observationTokens;
  }
  return { includeReflection: Boolean(state.reflection), chunkIds, tokens };
}
