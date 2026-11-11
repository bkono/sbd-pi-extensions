import {
  resolveBlockAfter,
  resolveBufferTokens,
  resolveRetentionFloor,
} from "./upstream/thresholds";

/**
 * Mastra Code's observational-memory settings (`@mastra/code-sdk@1.18.0`,
 * `src/agents/memory.ts` and `src/constants.ts`), resolved to absolute token counts.
 * There are no config files. These numbers are the product.
 */
export const MASTRA_CODE_OM = {
  observation: {
    messageTokens: 30_000,
    bufferTokens: 1 / 5,
    bufferActivation: 2_000,
    blockAfter: 2,
    previousObserverTokens: 1_000,
  },
  reflection: {
    observationTokens: 40_000,
    bufferActivation: 1 / 2,
    blockAfter: 1.1,
  },
  activateOnProviderChange: true,
} as const;

export interface ResolvedOMConfig {
  /** Observe threshold: pending message tokens at which buffered chunks activate. */
  messageTokens: number;
  /** Background observation interval in message tokens. */
  bufferTokens: number;
  /** Raw message tokens kept when buffered chunks activate. */
  retentionFloor: number;
  /** Pending message tokens at which observation blocks the agent. */
  observationBlockAfter: number;
  /** Prior observation tokens the observer sees. */
  previousObserverTokens: number;
  /** Per-tool-result token cap in the observer transcript. */
  observerToolResultMaxTokens: number;
  /** Reflection threshold in observation tokens. */
  reflectionTokens: number;
  /** Observation tokens at which background reflection starts. */
  reflectionBufferAt: number;
  /** Observation tokens at which reflection blocks the agent. */
  reflectionBlockAfter: number;
  activateOnProviderChange: boolean;
  /** Upper bound on waiting for in-flight buffering before a blocking observation. */
  bufferWaitMs: number;
  /** Timeout for one observer or reflector model call. */
  modelCallTimeoutMs: number;
  /** Explicit `provider/model` from `PI_OM_MODEL`, tried before the automatic chain. */
  modelOverride?: string;
  disabled: boolean;
  /** Append every OM event as a JSON line to this file (`PI_OM_TRACE`). */
  tracePath?: string;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ResolvedOMConfig {
  const o = MASTRA_CODE_OM.observation;
  const r = MASTRA_CODE_OM.reflection;
  const messageTokens = o.messageTokens;
  const reflectionTokens = r.observationTokens;
  return {
    messageTokens,
    bufferTokens: resolveBufferTokens(o.bufferTokens, messageTokens) ?? 6_000,
    retentionFloor: resolveRetentionFloor(o.bufferActivation, messageTokens),
    observationBlockAfter: resolveBlockAfter(o.blockAfter, messageTokens) ?? messageTokens * 2,
    previousObserverTokens: o.previousObserverTokens,
    observerToolResultMaxTokens: 5_000,
    reflectionTokens,
    reflectionBufferAt: reflectionTokens * r.bufferActivation,
    reflectionBlockAfter: resolveBlockAfter(r.blockAfter, reflectionTokens) ?? reflectionTokens,
    activateOnProviderChange: MASTRA_CODE_OM.activateOnProviderChange,
    bufferWaitMs: 60_000,
    modelCallTimeoutMs: 120_000,
    modelOverride: env.PI_OM_MODEL?.trim() || undefined,
    disabled: env.PI_OM_DISABLE === "1",
    tracePath: env.PI_OM_TRACE?.trim() || undefined,
  };
}
