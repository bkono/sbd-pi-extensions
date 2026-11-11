import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";

/**
 * Observer and reflector models resolve automatically. Order (Bryan, D4):
 * an explicit `PI_OM_MODEL`, then Codex, then Anthropic. With none available OM
 * disables itself instead of guessing.
 */
export const AUTO_MODEL_CHAIN: ReadonlyArray<readonly [provider: string, modelId: string]> = [
  ["openai-codex", "gpt-6-luna"],
  ["openai-codex", "gpt-5.6-luna"],
  ["anthropic", "claude-haiku-5-5"],
  ["anthropic", "claude-haiku-4-5"],
];

/** The subset of Pi's ModelRegistry OM uses. */
export interface ModelAccess {
  find(provider: string, modelId: string): Model<Api> | undefined;
  hasConfiguredAuth(model: Model<Api>): boolean;
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: { signal?: AbortSignal; maxTokens?: number; reasoning?: "minimal" | "low" },
  ): { result(): Promise<AssistantMessage> };
}

export function modelLabel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function resolveModelCandidates(registry: ModelAccess, override?: string): Model<Api>[] {
  const ids: Array<readonly [string, string]> = [];
  if (override) {
    const slash = override.indexOf("/");
    if (slash > 0) ids.push([override.slice(0, slash), override.slice(slash + 1)]);
  }
  ids.push(...AUTO_MODEL_CHAIN);
  const seen = new Set<string>();
  const candidates: Model<Api>[] = [];
  for (const [provider, modelId] of ids) {
    const key = `${provider}/${modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const model = registry.find(provider, modelId);
    if (model && registry.hasConfiguredAuth(model)) candidates.push(model);
  }
  return candidates;
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly attempts: string[],
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

export interface ModelCallResult {
  text: string;
  model: Model<Api>;
  message: AssistantMessage;
  /** Failed attempts before this one succeeded (retries and failovers). */
  failures: string[];
}

/**
 * Transient failures worth retrying on the same model. Status codes only count at the
 * start of the message or after "status"/"HTTP", so "402 … balance 500 credits" or
 * "max_tokens must be <= 512" stay permanent.
 */
const TRANSIENT =
  /^\s*(?:HTTP\s*)?(?:429|5\d\d)\b|\b(?:status(?:\s*code)?|HTTP)\s*:?\s*(?:429|5\d\d)\b|rate.?limit|overloaded|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|temporarily unavailable|service unavailable/i;
const RETRY_DELAYS_MS = [1_000, 4_000];

export function isTransientFailure(text: string): boolean {
  return TRANSIENT.test(text);
}

function withoutImages(context: Context): Context {
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (message.role !== "user" || typeof message.content === "string") return message;
      return { ...message, content: message.content.filter((block) => block.type !== "image") };
    }),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * One prompt, tried against each candidate until one returns text. A transient failure
 * (rate limit, 5xx, network, empty reply) is retried on the same model first, like
 * Mastra's withRetry, then the next model is tried. Uses `streamSimple` because Codex
 * OAuth only serves streaming requests. Images are dropped for models without image
 * input. An abort stops the chain.
 */
export async function completeWithFailover(
  registry: ModelAccess,
  candidates: readonly Model<Api>[],
  context: Context,
  options: { signal?: AbortSignal; timeoutMs: number; retryDelaysMs?: readonly number[] },
): Promise<ModelCallResult> {
  const attempts: string[] = [];
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  for (const model of candidates) {
    const modelContext = model.input?.includes("image") ? context : withoutImages(context);
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      if (options.signal?.aborted) break;
      if (attempt > 0) {
        await sleep(delays[attempt - 1]!, options.signal);
        if (options.signal?.aborted) break;
      }
      const signal = AbortSignal.any(
        [AbortSignal.timeout(options.timeoutMs), options.signal].filter(
          (s): s is AbortSignal => s !== undefined,
        ),
      );
      let failure: string;
      try {
        const reasoning = model.reasoning ? ("low" as const) : undefined;
        const message = await registry
          .streamSimple(model, modelContext, { signal, reasoning })
          .result();
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          failure = message.errorMessage ?? message.stopReason;
        } else {
          const text = message.content
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text)
            .join("")
            .trim();
          if (text) return { text, model, message, failures: attempts };
          failure = "empty response";
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      attempts.push(`${modelLabel(model)}: ${failure}`);
      if (!isTransientFailure(failure) && failure !== "empty response") break;
    }
    if (options.signal?.aborted) break;
  }
  throw new ModelCallError(
    attempts.length > 0 ? `all OM models failed: ${attempts.join("; ")}` : "no OM model available",
    attempts,
  );
}
