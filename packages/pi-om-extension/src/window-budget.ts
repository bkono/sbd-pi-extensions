import type { OMConfig } from "./types.js";

export const PI_DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

export interface ContextWindowBudget {
  compactAt: number;
  maxPublishMessageTokens: number;
  maxStageMessageTokens: number;
  maxPublishToolResultTokens: number;
  maxStageToolResultTokens: number;
  maxReflectionTokens: number;
  maxInjectedObservationTokens: number;
}

export function contextWindowBudget(
  contextWindow: number | undefined,
): ContextWindowBudget | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }

  const compactAt = contextWindow - PI_DEFAULT_COMPACTION_RESERVE_TOKENS;
  if (compactAt <= 0) return undefined;

  const maxPublishMessageTokens = Math.max(8_000, Math.floor(compactAt * 0.55));
  const maxPublishToolResultTokens = Math.max(4_000, Math.floor(maxPublishMessageTokens * 0.5));
  const maxReflectionTokens = Math.max(4_000, Math.floor(contextWindow * 0.12));

  return {
    compactAt,
    maxPublishMessageTokens,
    maxStageMessageTokens: Math.max(4_000, Math.floor(maxPublishMessageTokens * 0.5)),
    maxPublishToolResultTokens,
    maxStageToolResultTokens: Math.max(2_000, Math.floor(maxPublishToolResultTokens * 0.4)),
    maxReflectionTokens,
    maxInjectedObservationTokens: maxReflectionTokens,
  };
}

export function clampConfigToContextWindow(
  config: OMConfig,
  contextWindow: number | undefined,
): OMConfig {
  const budget = contextWindowBudget(contextWindow);
  if (!budget) return config;

  const stageMessageTokens = Math.min(
    config.observation.stageMessageTokens,
    budget.maxStageMessageTokens,
  );
  const publishMessageTokens = Math.min(
    config.observation.publishMessageTokens,
    budget.maxPublishMessageTokens,
  );
  const stageToolResultTokens = Math.min(
    config.observation.stageToolResultTokens,
    budget.maxStageToolResultTokens,
  );
  const publishToolResultTokens = Math.min(
    config.observation.publishToolResultTokens,
    budget.maxPublishToolResultTokens,
  );
  const reflectionTokens = Math.min(
    config.reflection.observationTokens,
    budget.maxReflectionTokens,
  );

  if (
    stageMessageTokens === config.observation.stageMessageTokens &&
    publishMessageTokens === config.observation.publishMessageTokens &&
    stageToolResultTokens === config.observation.stageToolResultTokens &&
    publishToolResultTokens === config.observation.publishToolResultTokens &&
    reflectionTokens === config.reflection.observationTokens
  ) {
    return config;
  }

  return {
    ...config,
    observation: {
      ...config.observation,
      stageMessageTokens,
      publishMessageTokens,
      stageToolResultTokens,
      publishToolResultTokens,
    },
    reflection: {
      ...config.reflection,
      observationTokens: reflectionTokens,
    },
  };
}
