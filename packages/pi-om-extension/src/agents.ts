import type { Api, AssistantMessage, KnownProvider, Model } from "@mariozechner/pi-ai";
import { completeSimple, getModel } from "@mariozechner/pi-ai";

import {
  buildObserverSystemPrompt,
  buildReflectorSystemPrompt,
  OBSERVATION_CONTINUATION_HINT,
} from "./prompts.js";
import { deriveObservationEntries } from "./temporal.js";
import type { ObserverResult, OMConfig } from "./types.js";

/**
 * Narrow subset of pi's `ModelRegistry` that the observer/reflector needs.
 * We accept this as an interface (not the concrete ModelRegistry) to avoid
 * a hard dependency on pi-coding-agent from the agents module and to make
 * tests easier to stub.
 */
export interface AuthResolver {
  getApiKeyAndHeaders(model: Model<Api>): Promise<{
    ok: boolean;
    apiKey?: string;
    headers?: Record<string, string>;
    error?: string;
  }>;
}

// ---------------------------------------------------------------------------
// XML tag extraction
// ---------------------------------------------------------------------------

function extractTag(raw: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)(?:<\\/${tag}>|$)`, "i");
  const match = raw.match(re);
  return match?.[1]?.trim() || undefined;
}

/**
 * Parse the observer/reflector LLM output into structured fields.
 *
 * Expects XML tags `<observations>`, `<current-task>`, `<suggested-response>`.
 * Falls back to treating the entire output as observations when tags are absent.
 */
export function parseObserverOutput(raw: string): ObserverResult {
  const normalized = raw.trim();
  const observationsTag = extractTag(normalized, "observations");
  const currentTaskTag = extractTag(normalized, "current-task");
  const suggestedTag = extractTag(normalized, "suggested-response");
  if (observationsTag || currentTaskTag || suggestedTag) {
    const observations = observationsTag ?? normalized;
    return {
      observations,
      observationEntries: deriveObservationEntries(observations),
      currentTask: currentTaskTag || undefined,
      suggestedResponse: suggestedTag || undefined,
      raw: normalized,
    };
  }
  // Fallback: try plain-text patterns for models that don't use XML
  const currentTaskMatch = normalized.match(/(?:^|\n)Current task:\s*(.+)$/im);
  const suggestedMatch = normalized.match(/(?:^|\n)Suggested response:\s*(.+)$/im);
  let observations = normalized;
  const cutoffIndices = [currentTaskMatch?.index, suggestedMatch?.index]
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  if (cutoffIndices.length > 0) {
    observations = normalized.slice(0, cutoffIndices[0]).trim();
  }

  return {
    observations,
    observationEntries: deriveObservationEntries(observations),
    currentTask: currentTaskMatch?.[1]?.trim(),
    suggestedResponse: suggestedMatch?.[1]?.trim(),
    raw: normalized,
  };
}

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

function debugLog(config: OMConfig, ...args: unknown[]): void {
  if (!config.debug) return;
  console.error("[om][agents]", ...args);
}

// ---------------------------------------------------------------------------
// ObservationAgents
// ---------------------------------------------------------------------------

export class ObservationAgents {
  constructor(
    private readonly config: OMConfig,
    private readonly authResolver?: AuthResolver,
  ) {}

  // ---- public API ----

  async observe(
    input: {
      existingObservations: string;
      serializedMessages: string;
      customInstruction?: string;
      includeContinuationHint?: boolean;
    },
    options?: { signal?: AbortSignal },
  ): Promise<ObserverResult> {
    const systemPrompt = buildObserverSystemPrompt(
      input.customInstruction ?? this.config.observation.customInstruction,
    );

    const sections: string[] = [];

    const previousObservations = input.existingObservations.trim();
    if (previousObservations) {
      sections.push(
        "## Previous Observations",
        "",
        previousObservations,
        "",
        "---",
        "",
        "Do not repeat these existing observations. Your new observations will be appended to the existing observations.",
        "",
      );
    }

    sections.push(
      "## New Message History to Observe",
      "",
      input.serializedMessages,
      "",
      "---",
      "",
      "## Your Task",
      "",
      "Extract new observations from the message history above. Do not repeat observations that are already in the previous observations. Add your new observations in the format specified in your instructions.",
    );

    if (input.includeContinuationHint) {
      sections.push("", `<system-reminder>${OBSERVATION_CONTINUATION_HINT}</system-reminder>`);
    }

    const userPrompt = sections.join("\n");

    debugLog(
      this.config,
      "observe: system prompt length",
      systemPrompt.length,
      "user prompt length",
      userPrompt.length,
    );

    const response = await this.complete(
      this.config.observation.provider,
      this.config.observation.modelId,
      systemPrompt,
      userPrompt,
      this.config.observation.temperature,
      options?.signal,
    );

    const result = parseObserverOutput(response);
    debugLog(this.config, "observe: observations length", result.observations.length);
    return result;
  }

  async reflect(
    input: {
      observations: string;
      customInstruction?: string;
    },
    options?: { signal?: AbortSignal },
  ): Promise<ObserverResult> {
    const systemPrompt = buildReflectorSystemPrompt(
      input.customInstruction ?? this.config.reflection.customInstruction,
    );

    const userPrompt = [
      "Consolidate the observations below without losing structure, exact values, or outcome state.",
      "Return only the XML blocks from your instructions.",
      "",
      "<current-observations>",
      input.observations,
      "</current-observations>",
    ].join("\n");

    debugLog(
      this.config,
      "reflect: system prompt length",
      systemPrompt.length,
      "user prompt length",
      userPrompt.length,
    );

    const response = await this.complete(
      this.config.reflection.provider,
      this.config.reflection.modelId,
      systemPrompt,
      userPrompt,
      this.config.reflection.temperature,
      options?.signal,
    );

    const result = parseObserverOutput(response);
    debugLog(this.config, "reflect: observations length", result.observations.length);
    return result;
  }

  // ---- internals ----

  private async complete(
    provider: KnownProvider,
    modelId: string,
    systemPrompt: string,
    userPrompt: string,
    temperature: number | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    // getModel's generic expects literal provider/modelId types at compile time.
    // At runtime we have string values, so we cast through the registry lookup.
    const model = getModel(
      provider as Parameters<typeof getModel>[0],
      modelId as Parameters<typeof getModel>[1],
    );

    if (!model) {
      throw new Error(`[om][agents] Model not found: provider=${provider} model=${modelId}`);
    }

    // Resolve API key via pi's auth chain (auth.json + env vars + OAuth refresh).
    // If no resolver is provided (e.g. unit tests), fall through and let pi-ai
    // read from environment variables directly.
    let resolvedApiKey: string | undefined;
    if (this.authResolver) {
      const auth = await this.authResolver.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        throw new Error(
          `[om][agents] Auth resolution failed for ${provider}: ${auth.error ?? "unknown error"}`,
        );
      }
      if (!auth.apiKey) {
        throw new Error(
          `[om][agents] No API key for provider: ${provider}. Configure it in ~/.pi/agent/auth.json or set the provider's env var.`,
        );
      }
      resolvedApiKey = auth.apiKey;
    }

    // Only pass temperature when explicitly configured. Reasoning models
    // (GPT-5.x, some Opus variants) reject the parameter entirely, so we let
    // the provider use its default unless the user opts in via config.
    const simpleOptions: { temperature?: number; apiKey?: string; signal?: AbortSignal } = {
      apiKey: resolvedApiKey,
    };
    if (temperature !== undefined) {
      simpleOptions.temperature = temperature;
    }
    if (signal) {
      simpleOptions.signal = signal;
    }

    const response: AssistantMessage = await completeSimple(
      model,
      {
        systemPrompt,
        messages: [
          {
            role: "user" as const,
            content: userPrompt,
            timestamp: Date.now(),
          },
        ],
      },
      simpleOptions,
    );

    if (response.stopReason === "error") {
      throw new Error(`[om][agents] LLM call failed: ${response.errorMessage ?? "unknown error"}`);
    }

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    debugLog(
      this.config,
      "complete: response length",
      text.length,
      "stop reason",
      response.stopReason,
    );

    return text;
  }
}
