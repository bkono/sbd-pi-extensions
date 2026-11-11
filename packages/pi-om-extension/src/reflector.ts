import type { Api, Model } from "@earendil-works/pi-ai";

import { completeWithFailover, type ModelAccess, modelLabel } from "./models.js";
import { countTokens } from "./tokens.js";
import { stripObservationGroups } from "./upstream/observation-groups";
import {
  detectDegenerateRepetition,
  parseReflectorSectionXml,
  sanitizeObservationLines,
  validateCompression,
} from "./upstream/parse";
import {
  buildReflectorSystemPrompt,
  COMPRESSION_GUIDANCE,
  type CompressionLevel,
  MAX_COMPRESSION_LEVEL,
} from "./upstream/prompts";

/** Mastra starts non-Gemini reflectors at compression level 1 (getCompressionStartLevel). */
export const REFLECTION_START_LEVEL: CompressionLevel = 1;

export interface ReflectOutput {
  observations: string;
  observationTokens: number;
  currentTask?: string;
  suggestedResponse?: string;
  model: string;
  level: CompressionLevel;
}

/** Mastra buildReflectorPrompt, without extractors. */
export function buildReflectorUserMessage(observations: string, level: CompressionLevel): string {
  let prompt = `## OBSERVATIONS TO REFLECT ON

${stripObservationGroups(observations)}

---

Please analyze these observations and produce a refined, condensed version that will become the assistant's entire memory going forward.`;
  const guidance = COMPRESSION_GUIDANCE[level];
  if (guidance) prompt += `\n\n${guidance}`;
  return prompt;
}

/**
 * Reflect until the result is below `targetTokens`, escalating compression up to three
 * levels past the start (Mastra reflector-runner `call`). The last attempt is accepted
 * even if it misses the target.
 */
export async function reflect(
  registry: ModelAccess,
  candidates: readonly Model<Api>[],
  observations: string,
  targetTokens: number,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<ReflectOutput> {
  const systemPrompt = buildReflectorSystemPrompt();
  const maxLevel = Math.min(MAX_COMPRESSION_LEVEL, REFLECTION_START_LEVEL + 3) as CompressionLevel;
  let best: ReflectOutput | undefined;
  for (let level = REFLECTION_START_LEVEL; level <= maxLevel; level += 1) {
    const result = await completeWithFailover(
      registry,
      candidates,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: buildReflectorUserMessage(observations, level as CompressionLevel),
            timestamp: Date.now(),
          },
        ],
      },
      options,
    );
    if (detectDegenerateRepetition(sanitizeObservationLines(result.text))) continue;
    const parsed = parseReflectorSectionXml(result.text);
    const reflected = sanitizeObservationLines(parsed.observations || "");
    if (!reflected.trim()) continue;
    const output: ReflectOutput = {
      observations: reflected,
      observationTokens: countTokens(reflected),
      currentTask: parsed.currentTask || undefined,
      suggestedResponse: parsed.suggestedResponse || undefined,
      model: modelLabel(result.model),
      level: level as CompressionLevel,
    };
    if (!best || output.observationTokens < best.observationTokens) best = output;
    if (validateCompression(output.observationTokens, targetTokens)) return output;
  }
  if (best) return best;
  throw new Error("reflector produced no usable output");
}
