import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import { completeWithFailover, type ModelAccess, modelLabel } from "./models.js";
import { countTokens, estimateTokens } from "./tokens.js";
import { collectImages, formatTranscript } from "./transcript.js";
import {
  detectDegenerateRepetition,
  parseMemorySectionXml,
  sanitizeObservationLines,
  sortObservationsByTime,
} from "./upstream/parse";
import {
  buildObserverSystemPrompt,
  type ExtractorSlug,
  OBSERVER_EXTRACTORS,
  withoutContinuationHints,
} from "./upstream/prompts";

function observerExtractors(buffered?: boolean): readonly ExtractorSlug[] {
  return buffered ? withoutContinuationHints(OBSERVER_EXTRACTORS) : OBSERVER_EXTRACTORS;
}

import { truncateObservationsToTokenBudget } from "./upstream/truncate";

/** Upper bound on images forwarded to the observer in one call. */
export const MAX_OBSERVER_IMAGES = 8;

/**
 * Pi-specific observer instruction, the analogue of Mastra Code's
 * DYNAMIC_AGENTS_MD_INSTRUCTION: transcript entries injected by extensions are labelled
 * `Custom <type>` and may be ephemeral.
 */
export const PI_OBSERVER_INSTRUCTION = `Lines labelled "Custom <type>" are messages injected by Pi extensions. Observe what they tell the assistant, but do not record ephemeral guidance or reminders that are re-sent on every turn.

<current-task> and <suggested-response> describe the primary assistant's work for the user. Never describe your own observation or extraction work there.`;

/** The Pi instruction for one call; the continuation guard only when those sections exist. */
export function piObserverInstruction(buffered?: boolean): string {
  return buffered ? PI_OBSERVER_INSTRUCTION.split("\n\n")[0]! : PI_OBSERVER_INSTRUCTION;
}

export interface ObserveInput {
  messages: AgentMessage[];
  activeObservations: string;
  priorCurrentTask?: string;
  priorSuggestedResponse?: string;
  priorThreadTitle?: string;
  /**
   * Background buffering call. Mastra's async buffer passes skipContinuationHints: no
   * current-task or suggested-response is asked for, and the prompt says to always
   * output <observations>.
   */
  buffered?: boolean;
  /** The message just before this batch, so a time gap at its start is still shown. */
  previousMessage?: AgentMessage;
  previousObserverTokens: number;
  toolResultMaxTokens: number;
}

export interface ObserveOutput {
  observations: string;
  observationTokens: number;
  currentTask?: string;
  suggestedResponse?: string;
  model: string;
  threadTitle?: string;
  /** Failed attempts (retries, failovers, unusable output) before the result. */
  failures: string[];
}

/** Mastra's single observer request: prior memory, then the history, then the task. */
export function buildObserverUserMessage(input: ObserveInput): string {
  let prompt = "";
  let previous = input.activeObservations.trim();
  let truncated = false;
  if (previous && estimateTokens(previous) > input.previousObserverTokens) {
    previous = truncateObservationsToTokenBudget(
      previous,
      input.previousObserverTokens,
      estimateTokens,
    );
    truncated = true;
  }
  if (previous) {
    prompt += `## Previous Observations\n\n${previous}\n\n---\n\n`;
    prompt +=
      "Do not repeat these existing observations. Your new observations will be appended to the existing observations.\n\n";
  }
  if (truncated) {
    prompt +=
      "Previous observations were truncated for context budget reasons.\nThe main agent still has full memory context outside this observer window.\n\n";
  }
  const extractors = observerExtractors(input.buffered);
  // Mastra buildObserverContextPrompt: dash lines for the values the sync strategy passes,
  // then one block per active extractor with a prior value (buildExtractorPriorLines).
  const prior: string[] = [];
  if (!input.buffered) {
    if (input.priorCurrentTask) prior.push(`- prior current-task: ${input.priorCurrentTask}`);
    if (input.priorSuggestedResponse)
      prior.push(`- prior suggested-response: ${input.priorSuggestedResponse}`);
    if (input.priorThreadTitle) prior.push(`- prior thread-title: ${input.priorThreadTitle}`);
  }
  const priorValues: Partial<Record<ExtractorSlug, string | undefined>> = {
    "current-task": input.priorCurrentTask,
    "suggested-response": input.priorSuggestedResponse,
    "thread-title": input.priorThreadTitle,
  };
  for (const slug of extractors) {
    const value = priorValues[slug];
    if (value) prior.push(`<${slug}>\n${value}\n</${slug}>`);
  }
  if (prior.length > 0) {
    prompt += `## Prior Thread Metadata\n\n${prior.join("\n")}\n\n`;
    prompt +=
      "Use the prior current-task, suggested-response, and thread-title as continuity hints, then update them based on the new messages.\n\n---\n\n";
  }
  prompt += `## New Message History to Observe\n\n${formatTranscript(input.messages, {
    toolResultMaxTokens: input.toolResultMaxTokens,
    previousMessage: input.previousMessage,
  })}`;
  prompt +=
    "\n\n---\n\n## Your Task\n\nExtract new observations from the message history above. Do not repeat observations that are already in the previous observations. Add your new observations in the format specified in your instructions.";
  if (input.buffered) prompt += "\n\nOutput <observations> every time.";
  return prompt;
}

export function parseObserverResponse(
  text: string,
): Omit<ObserveOutput, "model" | "failures"> | undefined {
  if (detectDegenerateRepetition(sanitizeObservationLines(text))) return undefined;
  const parsed = parseMemorySectionXml(text);
  const observations = sortObservationsByTime(sanitizeObservationLines(parsed.observations || ""));
  if (!observations.trim()) return undefined;
  return {
    observations,
    observationTokens: countTokens(observations),
    currentTask: parsed.currentTask || undefined,
    suggestedResponse: parsed.suggestedResponse || undefined,
    threadTitle: parsed.threadTitle || undefined,
  };
}

export async function observe(
  registry: ModelAccess,
  candidates: readonly Model<Api>[],
  input: ObserveInput,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<ObserveOutput> {
  const systemPrompt = buildObserverSystemPrompt(
    piObserverInstruction(input.buffered),
    observerExtractors(input.buffered),
  );
  const user = buildObserverUserMessage(input);
  const images = collectImages(input.messages, MAX_OBSERVER_IMAGES);
  // A degenerate or empty parse moves on to the next model, like a model error does.
  let remaining = [...candidates];
  const failures: string[] = [];
  while (remaining.length > 0) {
    const result = await completeWithFailover(
      registry,
      remaining,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: images.length > 0 ? [{ type: "text", text: user }, ...images] : user,
            timestamp: Date.now(),
          },
        ],
      },
      options,
    );
    const parsed = parseObserverResponse(result.text);
    if (parsed) {
      return {
        ...parsed,
        model: modelLabel(result.model),
        failures: [...failures, ...result.failures],
      };
    }
    failures.push(`${modelLabel(result.model)}: unparseable or degenerate output`);
    remaining = remaining.slice(remaining.indexOf(result.model) + 1);
  }
  throw new Error(`observer failed: ${failures.join("; ")}`);
}
