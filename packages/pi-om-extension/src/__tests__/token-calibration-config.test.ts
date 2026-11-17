import { describe, expect, it } from "vitest";

import { resolveConfig, thresholdsFor } from "../config.js";

const routes = [
  ["amazon-bedrock", "anthropic.claude-opus-5-5"],
  ["amazon-bedrock", "au.anthropic.claude-opus-5-5"],
  ["amazon-bedrock", "eu.anthropic.claude-opus-5-5"],
  ["amazon-bedrock", "global.anthropic.claude-opus-5-5"],
  ["amazon-bedrock", "jp.anthropic.claude-opus-5-5"],
  ["amazon-bedrock", "us.anthropic.claude-opus-5-5"],
  ["anthropic", "claude-opus-5-5"],
  ["cloudflare-ai-gateway", "claude-opus-5-5"],
  ["github-copilot", "claude-opus-5.5"],
  ["opencode", "claude-opus-5-5"],
  ["openrouter", "anthropic/claude-opus-5.5"],
  ["openrouter", "anthropic/claude-opus-5.5:batch"],
  ["radius", "claude-opus-5-5"],
  ["vercel-ai-gateway", "anthropic/claude-opus-5.5"],
  ["vercel-ai-gateway", "anthropic/claude-opus-5.5-batch"],
  ["vercel-ai-gateway", "anthropic/claude-opus-5.5-fast"],
] as const;

describe("candidate exact-model calibration configs", () => {
  it.each(routes)("resolves the installed route %s/%s", (provider, id) => {
    const base = resolveConfig({});
    const expected = {
      messageTokens: 21_429,
      bufferTokens: 4_286,
      retentionFloor: 1_429,
      observationBlockAfter: 42_857,
    };
    expect(thresholdsFor(base, { provider, id })).toEqual({ ...base, ...expected });
    expect(base).toEqual(resolveConfig({}));
  });

  it.each([
    ["amazon-bedrock", "anthropic.claude-opus-4-6-v1"],
    ["amazon-bedrock", "au.anthropic.claude-opus-4-6-v1"],
    ["amazon-bedrock", "eu.anthropic.claude-opus-4-6-v1"],
    ["amazon-bedrock", "global.anthropic.claude-opus-4-6-v1"],
    ["amazon-bedrock", "us.anthropic.claude-opus-4-6-v1"],
    ["anthropic", "claude-opus-4-6"],
    ["cloudflare-ai-gateway", "claude-opus-4-6"],
    ["opencode", "claude-opus-4-6"],
    ["openrouter", "anthropic/claude-opus-4.6"],
    ["openrouter", "anthropic/claude-opus-4.6:batch"],
    ["vercel-ai-gateway", "anthropic/claude-opus-4.6"],
    ["vercel-ai-gateway", "anthropic/claude-opus-4.6-batch"],
    ["anthropic", "claude-sonnet-4-6"],
    ["anthropic", "claude-haiku-4-5"],
    ["anthropic", "claude-opus-4-7"],
    ["anthropic", "claude-opus-5-5-unknown"],
    ["openai-codex", "claude-opus-5-5"],
    ["unknown-provider", "claude-opus-4-6"],
    ["amazon-bedrock", "us.anthropic.claude-opus-5-5-v99"],
    ["google-vertex-anthropic", "claude-opus-5-5@unknown"],
    ["openrouter", "anthropic/claude-opus-5.5:unknown"],
    ["openai-codex", "gpt-6.1-sol"],
    ["openai", "gpt-4.1"],
    ["custom", "claude-opus-5-5"],
  ])("preserves unmeasured %s/%s by identity", (provider, id) => {
    const base = resolveConfig({});
    expect(thresholdsFor(base, { provider, id })).toBe(base);
  });

  it("preserves a missing model by identity", () => {
    const base = resolveConfig({});
    expect(thresholdsFor(base, undefined)).toBe(base);
  });

  it("scales the supplied base rather than replacing unrelated settings", () => {
    const base = {
      ...resolveConfig({ PI_OM_TRACE: "/tmp/trace", PI_OM_MODEL: "custom/observer" }),
      messageTokens: 100_001,
      bufferTokens: 10_003,
      retentionFloor: 2_003,
      observationBlockAfter: 200_003,
    };
    expect(thresholdsFor(base, { provider: "anthropic", id: "claude-opus-5-5" })).toEqual({
      ...base,
      messageTokens: 71_429,
      bufferTokens: 7_145,
      retentionFloor: 1_431,
      observationBlockAfter: 142_859,
    });
  });
});
