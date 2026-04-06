import type { KnownProvider } from "@mariozechner/pi-ai";

export interface OMConfig {
  observation: {
    messageTokens: number;
    provider: KnownProvider;
    modelId: string;
    /**
     * Temperature to pass to the observer LLM call. Left unset by default
     * because reasoning models (GPT-5.x, some Opus variants) reject the
     * parameter entirely. Set to a number (e.g. 0.2) if your chosen model
     * supports it and you want deterministic observation output.
     */
    temperature?: number;
    customInstruction?: string;
  };
  reflection: {
    observationTokens: number;
    provider: KnownProvider;
    modelId: string;
    /** See observation.temperature. */
    temperature?: number;
    customInstruction?: string;
  };
  storage: {
    stateDir: string;
  };
  debug: boolean;
}

export type CursorMode = "none" | "id" | "timestamp" | "fallback-latest";

export interface SessionState {
  sessionId: string;
  observations: string;
  observationTokens: number;
  lastObservedEntryId?: string;
  lastObservedTimestamp?: number;
  currentTask?: string;
  suggestedResponse?: string;
  lastCycleAt?: number;
  lastCycleReason?: string;
  lastCursorMode?: CursorMode;
  tailEntriesBeforePrune?: number;
  tailTokensBeforePrune?: number;
  tailEntriesAfterPrune?: number;
  tailTokensAfterPrune?: number;
  observeTriggered?: boolean;
  reflectTriggered?: boolean;
  prunedEntriesCount?: number;
  updatedAt: number;
}

export interface ObserverResult {
  observations: string;
  currentTask?: string;
  suggestedResponse?: string;
  raw: string;
}

export type CycleReason = "turn_end" | "context" | "compacting";
