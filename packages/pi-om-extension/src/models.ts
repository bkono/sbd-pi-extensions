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
}

/**
 * One prompt, tried against each candidate until one returns text. Uses `streamSimple`
 * because Codex OAuth only serves streaming requests. An abort stops the chain.
 */
export async function completeWithFailover(
  registry: ModelAccess,
  candidates: readonly Model<Api>[],
  context: Context,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<ModelCallResult> {
  const attempts: string[] = [];
  for (const model of candidates) {
    if (options.signal?.aborted) break;
    const signal = AbortSignal.any(
      [AbortSignal.timeout(options.timeoutMs), options.signal].filter(
        (s): s is AbortSignal => s !== undefined,
      ),
    );
    try {
      const reasoning = model.reasoning ? ("low" as const) : undefined;
      const message = await registry.streamSimple(model, context, { signal, reasoning }).result();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        attempts.push(`${modelLabel(model)}: ${message.errorMessage ?? message.stopReason}`);
        continue;
      }
      const text = message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      if (!text) {
        attempts.push(`${modelLabel(model)}: empty response`);
        continue;
      }
      return { text, model, message };
    } catch (error) {
      attempts.push(
        `${modelLabel(model)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new ModelCallError(
    attempts.length > 0 ? `all OM models failed: ${attempts.join("; ")}` : "no OM model available",
    attempts,
  );
}
