import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { wrapInObservationGroup } from "./upstream/observation-groups";

/**
 * OM state lives in the Pi session as custom entries on the active branch:
 *
 * - `om.chunk`: one observer result covering a contiguous run of entries.
 * - `om.activation`: chunks swapped into active memory. The same boundary also commits
 *   one `context_edit` per covered entry, so Pi omits them from future requests.
 * - `om.reflection`: a new memory generation that folds a set of activated chunks.
 *
 * Active memory = latest reflection + chunks activated after it. Everything is
 * branch-relative, so `/tree` and fork carry a consistent OM state.
 */
export const OM_CHUNK = "om.chunk";
export const OM_ACTIVATION = "om.activation";
export const OM_REFLECTION = "om.reflection";

export type ActivationTrigger = "threshold" | "ttl" | "provider_change" | "block" | "compaction";

export interface ChunkData {
  v: 1;
  id: string;
  observations: string;
  observationTokens: number;
  /** Message tokens of the covered entries when the chunk was observed. */
  messageTokens: number;
  entryIds: string[];
  /** `firstEntryId:lastEntryId`, used by recall. */
  range: string;
  createdAt: number;
  model: string;
  currentTask?: string;
  suggestedResponse?: string;
  /** Title the observer proposed; OM applies it as the Pi session name unless the user named it. */
  threadTitle?: string;
}

export interface ActivationData {
  v: 1;
  chunkIds: string[];
  trigger: ActivationTrigger;
  at: number;
  /** Message tokens removed from context by this activation. */
  messageTokens: number;
}

export interface ReflectionData {
  v: 1;
  id: string;
  generation: number;
  observations: string;
  observationTokens: number;
  /** Activated chunks whose content this reflection replaces. */
  foldedChunkIds: string[];
  at: number;
  model: string;
  currentTask?: string;
  suggestedResponse?: string;
}

export type OMEntryDraft =
  | { customType: typeof OM_CHUNK; data: ChunkData }
  | { customType: typeof OM_ACTIVATION; data: ActivationData }
  | { customType: typeof OM_REFLECTION; data: ReflectionData };

export interface OMState {
  chunks: Map<string, ChunkData>;
  /** Activated chunk ids, in activation order. */
  activated: string[];
  reflection?: ReflectionData;
  /** Activated chunks not folded into the latest reflection, in activation order. */
  activeChunks: ChunkData[];
  /** Buffered chunks that are not activated yet, in creation order. */
  buffered: ChunkData[];
  /** Entries covered by any activated chunk (folded or not). */
  observedEntryIds: Set<string>;
  /** Entries covered by buffered chunks. */
  bufferedEntryIds: Set<string>;
  observationTokens: number;
  generation: number;
  /** Task and suggestion shown to the model: as of the last activation or reflection. */
  currentTask?: string;
  suggestedResponse?: string;
  /**
   * Latest task and suggestion from any observation, buffered or not. Mastra persists
   * these at buffer time and feeds them to the next observer call as prior hints; the
   * section only picks them up at activation, so it stays cache-stable in between.
   */
  latestTask?: string;
  latestSuggestion?: string;
  /** Last OM write that changed what the model sees (activation or reflection). */
  lastActivationAt?: number;
}

function isOMCustomEntry(
  entry: SessionEntry,
): entry is SessionEntry & { type: "custom"; customType: string; data: unknown } {
  return (
    entry.type === "custom" &&
    typeof (entry as { customType?: unknown }).customType === "string" &&
    (entry as { customType: string }).customType.startsWith("om.")
  );
}

/** Replays OM state from branch entries plus drafts not yet committed. */
export function replayState(
  entries: readonly SessionEntry[],
  pending: readonly OMEntryDraft[] = [],
): OMState {
  const drafts: OMEntryDraft[] = [];
  for (const entry of entries) {
    if (!isOMCustomEntry(entry)) continue;
    const data = entry.data as { v?: number } | undefined;
    if (!data || data.v !== 1) continue;
    if (
      entry.customType === OM_CHUNK ||
      entry.customType === OM_ACTIVATION ||
      entry.customType === OM_REFLECTION
    ) {
      drafts.push({ customType: entry.customType, data } as OMEntryDraft);
    }
  }
  drafts.push(...pending);

  const chunks = new Map<string, ChunkData>();
  const chunkOrder: string[] = [];
  const activated: string[] = [];
  const activatedSet = new Set<string>();
  let reflection: ReflectionData | undefined;
  let currentTask: string | undefined;
  let suggestedResponse: string | undefined;
  let latestTask: string | undefined;
  let latestSuggestion: string | undefined;
  let lastActivationAt: number | undefined;

  for (const draft of drafts) {
    switch (draft.customType) {
      case OM_CHUNK:
        if (!chunks.has(draft.data.id)) chunkOrder.push(draft.data.id);
        chunks.set(draft.data.id, draft.data);
        if (draft.data.currentTask) latestTask = draft.data.currentTask;
        if (draft.data.suggestedResponse) latestSuggestion = draft.data.suggestedResponse;
        break;
      case OM_ACTIVATION:
        for (const id of draft.data.chunkIds) {
          const chunk = chunks.get(id);
          if (!chunk || activatedSet.has(id)) continue;
          activatedSet.add(id);
          activated.push(id);
        }
        currentTask = latestTask ?? currentTask;
        suggestedResponse = latestSuggestion ?? suggestedResponse;
        lastActivationAt = draft.data.at;
        break;
      case OM_REFLECTION:
        reflection = draft.data;
        if (draft.data.currentTask) currentTask = latestTask = draft.data.currentTask;
        if (draft.data.suggestedResponse) {
          suggestedResponse = latestSuggestion = draft.data.suggestedResponse;
        }
        lastActivationAt = draft.data.at;
        break;
    }
  }

  const folded = new Set(reflection?.foldedChunkIds ?? []);
  const activeChunks = activated
    .filter((id) => !folded.has(id))
    .map((id) => chunks.get(id))
    .filter((chunk): chunk is ChunkData => chunk !== undefined);

  const observedEntryIds = new Set<string>();
  for (const id of activated)
    for (const entryId of chunks.get(id)?.entryIds ?? []) observedEntryIds.add(entryId);

  const buffered: ChunkData[] = [];
  const bufferedEntryIds = new Set<string>();
  for (const id of chunkOrder) {
    if (activatedSet.has(id)) continue;
    const chunk = chunks.get(id)!;
    // A chunk that overlaps observed entries is stale (a sync pass covered them first).
    if (chunk.entryIds.some((entryId) => observedEntryIds.has(entryId))) continue;
    buffered.push(chunk);
    for (const entryId of chunk.entryIds) bufferedEntryIds.add(entryId);
  }

  const observationTokens =
    (reflection?.observationTokens ?? 0) +
    activeChunks.reduce((sum, chunk) => sum + chunk.observationTokens, 0);

  return {
    chunks,
    activated,
    reflection,
    activeChunks,
    buffered,
    observedEntryIds,
    bufferedEntryIds,
    observationTokens,
    generation: reflection?.generation ?? 0,
    currentTask,
    suggestedResponse,
    latestTask,
    latestSuggestion,
    lastActivationAt,
  };
}

/** Active memory text: reflection, then each active chunk as an observation group. */
export function renderActiveObservations(state: OMState): string {
  const parts: string[] = [];
  if (state.reflection?.observations.trim()) parts.push(state.reflection.observations.trim());
  for (const chunk of state.activeChunks) {
    if (!chunk.observations.trim()) continue;
    parts.push(wrapInObservationGroup(chunk.observations, chunk.range, chunk.id));
  }
  return parts.join("\n\n");
}

export function hasActiveMemory(state: OMState): boolean {
  return Boolean(state.reflection?.observations.trim()) || state.activeChunks.length > 0;
}
