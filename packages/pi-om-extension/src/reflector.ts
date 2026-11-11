import type { Api, Model } from "@earendil-works/pi-ai";

import { completeWithFailover, type ModelAccess, modelLabel } from "./models.js";
import { countTokens } from "./tokens.js";
import {
  reconcileObservationGroupsFromReflection,
  stripObservationGroups,
} from "./upstream/observation-groups";
import {
  detectDegenerateRepetition,
  parseReflectorSectionXml,
  sanitizeObservationLines,
  validateCompression,
} from "./upstream/parse";
import {
  buildExtractorOutputSections,
  buildReflectorSystemPrompt,
  COMPRESSION_GUIDANCE,
  type CompressionLevel,
  type ExtractorSlug,
  MAX_COMPRESSION_LEVEL,
  REFLECTOR_EXTRACTORS,
  withoutContinuationHints,
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
  failures: string[];
}

/** Mastra buildReflectorPrompt with the extractors Mastra Code composes. */
export function buildReflectorUserMessage(
  observations: string,
  level: CompressionLevel,
  options: { buffered?: boolean; priorCurrentTask?: string; priorSuggestedResponse?: string } = {},
): string {
  let prompt = `## OBSERVATIONS TO REFLECT ON

${stripObservationGroups(observations)}

---

Please analyze these observations and produce a refined, condensed version that will become the assistant's entire memory going forward.`;
  const guidance = COMPRESSION_GUIDANCE[level];
  if (guidance) prompt += `\n\n${guidance}`;
  const extractors = reflectorExtractors(options.buffered);
  const values: Partial<Record<ExtractorSlug, string | undefined>> = {
    "current-task": options.priorCurrentTask,
    "suggested-response": options.priorSuggestedResponse,
  };
  const priorLines = extractors
    .map((slug) => (values[slug] ? `<${slug}>\n${values[slug]}\n</${slug}>` : undefined))
    .filter((line): line is string => Boolean(line));
  if (priorLines.length > 0) {
    prompt += `\n\n## Prior Extracted Values\n\n${priorLines.join("\n\n")}\n\nUse these as carry-forward hints, then update them only when the observations justify a change.`;
  }
  const sections = buildExtractorOutputSections(extractors);
  if (sections) prompt += `\n\n## Additional Output Sections\n\n${sections}`;
  if (options.buffered) prompt += `\n\nOutput <observations> every time.`;
  return prompt;
}

function reflectorExtractors(buffered?: boolean): readonly ExtractorSlug[] {
  return buffered ? withoutContinuationHints(REFLECTOR_EXTRACTORS) : REFLECTOR_EXTRACTORS;
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
  options: {
    signal?: AbortSignal;
    timeoutMs: number;
    buffered?: boolean;
    priorCurrentTask?: string;
    priorSuggestedResponse?: string;
  },
): Promise<ReflectOutput> {
  const systemPrompt = buildReflectorSystemPrompt(undefined, reflectorExtractors(options.buffered));
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
            content: buildReflectorUserMessage(observations, level as CompressionLevel, options),
            timestamp: Date.now(),
          },
        ],
      },
      options,
    );
    if (detectDegenerateRepetition(sanitizeObservationLines(result.text))) continue;
    const parsed = parseReflectorSectionXml(result.text);
    const sanitized = sanitizeObservationLines(parsed.observations || "");
    // Mastra parseReflectorOutput: keep observation-group provenance (ids and source
    // ranges) so recall still reaches the raw messages behind reflected memory.
    const reflected =
      reconcileObservationGroupsFromReflection(sanitized, observations) ?? sanitized;
    if (!reflected.trim()) continue;
    const output: ReflectOutput = {
      observations: reflected,
      observationTokens: countTokens(reflected),
      currentTask: parsed.currentTask || undefined,
      suggestedResponse: parsed.suggestedResponse || undefined,
      model: modelLabel(result.model),
      level: level as CompressionLevel,
      failures: result.failures,
    };
    if (!best || output.observationTokens < best.observationTokens) best = output;
    if (validateCompression(output.observationTokens, targetTokens)) return output;
  }
  if (best) return best;
  throw new Error("reflector produced no usable output");
}
