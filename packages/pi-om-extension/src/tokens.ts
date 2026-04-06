import type { Message } from "@mariozechner/pi-ai";
import { getEncoding } from "js-tiktoken";

const encoder = getEncoding("o200k_base");

export function countTokens(text: string): number {
  return encoder.encode(text).length;
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
  let total = 0;
  for (const msg of messages) {
    total += countTokens(serializeMessage(msg));
  }
  return total;
}
