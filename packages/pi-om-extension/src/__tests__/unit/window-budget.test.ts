import { describe, expect, it } from "vitest";
import type { OMConfig } from "../../types.js";
import { clampConfigToContextWindow, contextWindowBudget } from "../../window-budget.js";

function config(overrides?: {
  stageMessageTokens?: number;
  publishMessageTokens?: number;
  stageToolResultTokens?: number;
  publishToolResultTokens?: number;
  reflectionTokens?: number;
}): OMConfig {
  return {
    observation: {
      stageMessageTokens: overrides?.stageMessageTokens ?? 96_000,
      publishMessageTokens: overrides?.publishMessageTokens ?? 192_000,
      stageMessageCount: 48,
      publishMessageCount: 96,
      stageToolResultTokens: overrides?.stageToolResultTokens ?? 32_000,
      publishToolResultTokens: overrides?.publishToolResultTokens ?? 96_000,
      maxChunkMessageTokens: 32_000,
      maxChunkMessages: 32,
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
    },
    reflection: {
      observationTokens: overrides?.reflectionTokens ?? 120_000,
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
    },
    storage: { stateDir: "/tmp/om-test" },
    debug: false,
  };
}

describe("contextWindowBudget", () => {
  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    -1,
    16_384,
  ])("returns undefined for unusable context window %s", (contextWindow) => {
    expect(contextWindowBudget(contextWindow)).toBeUndefined();
  });

  it("derives the expected limits for a 200k context window", () => {
    expect(contextWindowBudget(200_000)).toEqual({
      compactAt: 183_616,
      maxPublishMessageTokens: 100_988,
      maxStageMessageTokens: 50_494,
      maxPublishToolResultTokens: 50_494,
      maxStageToolResultTokens: 20_197,
      maxReflectionTokens: 24_000,
      maxInjectedObservationTokens: 24_000,
    });
  });

  it("leaves 1M-class defaults within the derived limits", () => {
    const budget = contextWindowBudget(1_000_000)!;
    expect(budget.maxPublishMessageTokens).toBeGreaterThan(192_000);
    expect(budget.maxStageMessageTokens).toBeGreaterThan(96_000);
    expect(budget.maxReflectionTokens).toBeGreaterThanOrEqual(120_000);
  });
});

describe("clampConfigToContextWindow", () => {
  it("clamps only thresholds above a 200k model budget", () => {
    const result = clampConfigToContextWindow(config(), 200_000);

    expect(result.observation.stageMessageTokens).toBe(50_494);
    expect(result.observation.publishMessageTokens).toBe(100_988);
    expect(result.observation.stageToolResultTokens).toBe(20_197);
    expect(result.observation.publishToolResultTokens).toBe(50_494);
    expect(result.reflection.observationTokens).toBe(24_000);
  });

  it("never raises lower user-configured thresholds", () => {
    const configured = config({
      stageMessageTokens: 10_000,
      publishMessageTokens: 20_000,
      stageToolResultTokens: 5_000,
      publishToolResultTokens: 10_000,
      reflectionTokens: 8_000,
    });

    expect(clampConfigToContextWindow(configured, 200_000)).toBe(configured);
  });

  it("returns the same config object when the context window is unknown", () => {
    const configured = config();
    expect(clampConfigToContextWindow(configured, undefined)).toBe(configured);
  });

  it("recomputes from the original config across model window changes", () => {
    const configured = config();
    const small = clampConfigToContextWindow(configured, 200_000);
    const large = clampConfigToContextWindow(configured, 1_000_000);

    expect(small).not.toBe(configured);
    expect(large).toBe(configured);
    expect(large.observation.publishMessageTokens).toBe(192_000);
  });
});
