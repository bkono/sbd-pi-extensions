/** Local shims for the Mastra types the vendored upstream files reference. */
export interface ThresholdRange {
  min: number;
  max: number;
}

/** Subset of Mastra's BufferedObservationChunk used by threshold math. */
export interface BufferedObservationChunk {
  messageTokens?: number;
}

export interface ObservationModelContext {
  provider?: string;
  modelId?: string;
  providerOptions?: Record<string, unknown>;
}

export type ResolvedActivationTTL = number | "auto";

export interface ParsedActivationTTLMap {
  default?: ResolvedActivationTTL | false;
  providers: Record<string, ResolvedActivationTTL | false>;
}
