import type { KnownProvider } from "@mariozechner/pi-ai";

export interface OMConfig {
  observation: {
    stageMessageTokens: number;
    publishMessageTokens: number;
    provider: KnownProvider;
    modelId: string;
    /**
     * Temperature to pass to the observer LLM call. Left unset by default
     * because reasoning models (GPT-5.x, some Opus variants) reject the
     * parameter entirely. Set to a number (e.g. 0.2) if your chosen model
     * supports it and you want deterministic observation output.
     */
    temperature?: number;
    /**
     * Timeout in milliseconds for the observer LLM call. Defaults to 120 000
     * (2 minutes). Prevents a slow or hung API call from blocking the agent
     * lifecycle indefinitely.
     */
    timeout?: number;
    customInstruction?: string;
  };
  reflection: {
    observationTokens: number;
    provider: KnownProvider;
    modelId: string;
    /** See observation.temperature. */
    temperature?: number;
    /**
     * Timeout in milliseconds for the reflector LLM call. Defaults to 120 000
     * (2 minutes).
     */
    timeout?: number;
    customInstruction?: string;
  };
  storage: {
    stateDir: string;
  };
  debug: boolean;
}

export type CursorMode = "none" | "id" | "timestamp" | "fallback-latest";

export type TemporalAnchorPrecision = "exact" | "day" | "week" | "month" | "approximate";

export type TemporalAnchorRelation = "past" | "current" | "future" | "ongoing";

export interface TemporalAnchor {
  recordedAt: string;
  originalPhrase: string;
  referencedStart?: string;
  referencedEnd?: string;
  precision: TemporalAnchorPrecision;
  relation: TemporalAnchorRelation;
}

export interface ObservationEntry {
  date: string;
  line: string;
  temporalAnchors?: TemporalAnchor[];
}

export interface SessionState {
  sessionId: string;
  observations: string;
  observationEntries?: ObservationEntry[];
  observationTokens: number;
  lastObservedEntryId?: string;
  lastObservedTimestamp?: number;
  currentTask?: string;
  suggestedResponse?: string;
  draftObservations: string;
  draftObservationEntries?: ObservationEntry[];
  draftObservationTokens: number;
  draftLastObservedEntryId?: string;
  draftLastObservedTimestamp?: number;
  draftCurrentTask?: string;
  draftSuggestedResponse?: string;
  lastCycleAt?: number;
  lastCycleReason?: string;
  lastCursorMode?: CursorMode;
  tailEntriesBeforePrune?: number;
  tailTokensBeforePrune?: number;
  tailEntriesAfterPrune?: number;
  tailTokensAfterPrune?: number;
  observeTriggered?: boolean;
  publishTriggered?: boolean;
  reflectTriggered?: boolean;
  prunedEntriesCount?: number;
  updatedAt: number;
}

export interface ObserverResult {
  observations: string;
  observationEntries?: ObservationEntry[];
  currentTask?: string;
  suggestedResponse?: string;
  raw: string;
}

export type CycleReason = "turn_end" | "context" | "compacting";
