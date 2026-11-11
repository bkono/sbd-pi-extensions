import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getEncoding } from "js-tiktoken";

const encoder = getEncoding("o200k_base");

/** Flat per-image estimate. Providers bill images by size; this only needs to be stable. */
export const IMAGE_TOKEN_ESTIMATE = 1_000;

export function countTokens(text: string): number {
  if (!text) return 0;
  // Transcripts can contain tokenizer sentinel literals such as `<|endoftext|>`.
  // Allow them so accounting never throws on ordinary content.
  return encoder.encode(text, "all").length;
}

/** Cheap estimate for hot loops over observation lines (Mastra uses tokenx the same way). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
};

function contentText(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  const parts: string[] = [];
  let images = 0;
  for (const raw of content as ContentBlock[]) {
    if (!raw || typeof raw !== "object") continue;
    switch (raw.type) {
      case "text":
        parts.push(raw.text ?? "");
        break;
      case "thinking":
        parts.push(raw.thinking ?? "");
        break;
      case "toolCall":
        parts.push(`${raw.name ?? ""} ${safeJson(raw.arguments)}`);
        break;
      case "image":
        images += 1;
        break;
      default:
        break;
    }
  }
  return { text: parts.join("\n"), images };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

/** Tokens a message contributes to provider context. */
export function countMessageTokens(message: AgentMessage): number {
  const m = message as { role?: string; content?: unknown } & Record<string, unknown>;
  switch (m.role) {
    case "bashExecution":
      return countTokens(`${String(m.command ?? "")}\n${String(m.output ?? "")}`);
    case "compactionSummary":
    case "branchSummary":
      return countTokens(String(m.summary ?? ""));
    default: {
      const { text, images } = contentText(m.content);
      return countTokens(text) + images * IMAGE_TOKEN_ESTIMATE;
    }
  }
}

/**
 * Per-entry token cache. Session entries are immutable once written, so an entry id
 * is a sound cache key. This keeps per-request accounting incremental.
 */
export class EntryTokenCache {
  private readonly cache = new Map<string, number>();

  count(entryId: string, messages: readonly AgentMessage[]): number {
    const cached = this.cache.get(entryId);
    if (cached !== undefined) return cached;
    let total = 0;
    for (const message of messages) total += countMessageTokens(message);
    this.cache.set(entryId, total);
    return total;
  }
}
