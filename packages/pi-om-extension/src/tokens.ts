import type { Message } from "@mariozechner/pi-ai";
import { getEncoding } from "js-tiktoken";

import type { ObservationWindowStats } from "./types.js";

const encoder = getEncoding("o200k_base");

interface CountedMessage {
  message: Message;
  tokens: number;
  isToolResult: boolean;
}

const EMPTY_WINDOW_STATS: ObservationWindowStats = {
  messageCount: 0,
  messageTokens: 0,
  toolResultCount: 0,
  toolResultTokens: 0,
};

export function countTokens(text: string): number {
  // Raw transcripts can legitimately contain tokenizer sentinel literals like
  // `<|endoftext|>`. Allow them during accounting so OM lifecycle hooks don't
  // crash while measuring message windows.
  return encoder.encode(text, "all").length;
}

export function serializeMessage(message: Message): string {
  const msg = message as unknown as Record<string, unknown>;
  const role = msg.role as string | undefined;
  const ts =
    typeof msg.timestamp === "number" ? new Date(msg.timestamp as number).toISOString() : "unknown";

  switch (role) {
    case "user": {
      const m = message as {
        role: "user";
        content: string | { type: string; text?: string }[];
        timestamp: number;
      };
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      return `role=user timestamp=${ts}\n${text}`;
    }

    case "assistant": {
      const m = message as {
        role: "assistant";
        content: {
          type: string;
          text?: string;
          thinking?: string;
          name?: string;
          input?: string;
        }[];
        model: string;
        timestamp: number;
      };
      const header = `role=assistant timestamp=${ts} model=${m.model}`;
      const parts = m.content.map((c) => {
        switch (c.type) {
          case "text":
            return `part:text ${c.text ?? ""}`;
          case "thinking":
            return `part:thinking ${c.thinking ?? ""}`;
          case "toolCall":
            return `part:toolCall name=${c.name ?? "unknown"} input=${c.input ?? "{}"}`;
          default:
            return `part:${c.type} ${JSON.stringify(c)}`;
        }
      });
      return [header, ...parts].join("\n");
    }

    case "toolResult": {
      const m = message as {
        role: "toolResult";
        toolName: string;
        content: { type: string; text?: string }[];
        timestamp: number;
      };
      const header = `role=toolResult timestamp=${ts} tool=${m.toolName}`;
      const parts = m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => `part:text ${c.text}`);
      return [header, ...parts].join("\n");
    }

    default: {
      // Fallback for custom AgentMessage types we don't explicitly handle
      return `role=${role ?? "unknown"} timestamp=${ts}\n${JSON.stringify(msg)}`;
    }
  }
}

export function countMessageTokens(messages: Message[]): number {
  return summarizeMessageWindow(messages).messageTokens;
}

export function summarizeMessageWindow(messages: Message[]): ObservationWindowStats {
  if (messages.length === 0) {
    return { ...EMPTY_WINDOW_STATS };
  }

  const counted = messages.map(countMessage);
  return summarizeCountedMessages(counted);
}

export function selectMessageChunk(
  messages: Message[],
  limits: { maxMessages: number; maxTokens: number },
): Message[] {
  if (messages.length === 0) {
    return [];
  }

  const maxMessages = normalizePositiveLimit(limits.maxMessages);
  const maxTokens = normalizePositiveLimit(limits.maxTokens);
  const counted = messages.map(countMessage);
  const selected: CountedMessage[] = [];
  let totalTokens = 0;

  for (const entry of counted) {
    const exceedsMessageLimit = selected.length >= maxMessages;
    const exceedsTokenLimit = selected.length > 0 && totalTokens + entry.tokens > maxTokens;
    if (exceedsMessageLimit || exceedsTokenLimit) {
      break;
    }

    selected.push(entry);
    totalTokens += entry.tokens;
  }

  if (selected.length === 0) {
    return [counted[0]!.message];
  }

  return selected.map((entry) => entry.message);
}

function summarizeCountedMessages(messages: CountedMessage[]): ObservationWindowStats {
  return messages.reduce<ObservationWindowStats>(
    (stats, entry) => {
      stats.messageCount += 1;
      stats.messageTokens += entry.tokens;
      if (entry.isToolResult) {
        stats.toolResultCount += 1;
        stats.toolResultTokens += entry.tokens;
      }
      return stats;
    },
    { ...EMPTY_WINDOW_STATS },
  );
}

function countMessage(message: Message): CountedMessage {
  const serialized = serializeMessage(message);
  return {
    message,
    tokens: countTokens(serialized),
    isToolResult: getMessageRole(message) === "toolResult",
  };
}

function getMessageRole(message: Message): string | undefined {
  return (message as { role?: unknown }).role as string | undefined;
}

function normalizePositiveLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return value;
}
