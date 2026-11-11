import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { countTokens } from "./tokens.js";

/**
 * Renders Pi messages as the observer transcript, in Mastra's observer format:
 * a `Mon D YYYY:` header per day, then `Role (h:mm AM): body` lines, with tool calls and
 * results on their own timed lines. Tool arguments are always included (the 0.3 bug was
 * dropping them); tool results are capped at a token budget.
 */
export interface TranscriptOptions {
  toolResultMaxTokens: number;
  /** Cap for one reasoning block, in characters. */
  reasoningMaxChars?: number;
  timeZone?: string;
}

interface Line {
  date: string;
  time: string;
  title: string;
  body: string;
  alwaysShowTime: boolean;
}

const TOOL_ARG_STRING_PREVIEW = 400;
const TOOL_ARGS_MAX_CHARS = 2_000;
const DEFAULT_REASONING_MAX_CHARS = 2_000;

function formatDate(ts: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).formatToParts(new Date(ts));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${part("month")} ${part("day")} ${part("year")}`;
}

function formatTime(ts: number, timeZone?: string): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Truncates `text` to at most `maxTokens`, keeping the head (Mastra truncateStringByTokens). */
export function truncateByTokens(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return "";
  // A token is at least one character, so a prefix of `maxTokens * 8` characters bounds the
  // search without encoding a huge tool result on every probe.
  if (text.length <= maxTokens) return text;
  const total = countTokens(text);
  if (total <= maxTokens) return text;
  let low = 0;
  let high = Math.min(text.length, maxTokens * 8);
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const visible = text.slice(0, mid);
    const candidate = `${visible}\n... [truncated ~${total - countTokens(visible)} tokens]`;
    if (countTokens(candidate) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function previewArgs(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= TOOL_ARG_STRING_PREVIEW) return value;
    return `${value.slice(0, TOOL_ARG_STRING_PREVIEW)}… [${value.length} chars]`;
  }
  if (Array.isArray(value)) {
    if (depth > 4) return `[array(${value.length})]`;
    return value.map((item) => previewArgs(item, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth > 4) return "{…}";
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = previewArgs(entry, depth + 1);
    return out;
  }
  return value;
}

export function formatToolArguments(args: unknown): string {
  if (args === undefined) return "[arguments unavailable]";
  let rendered: string;
  try {
    rendered = JSON.stringify(previewArgs(args));
  } catch {
    rendered = String(args);
  }
  if (rendered.length <= TOOL_ARGS_MAX_CHARS) return rendered;
  return `${rendered.slice(0, TOOL_ARGS_MAX_CHARS)}… [${rendered.length} chars]`;
}

type Block = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
  redacted?: boolean;
};

function textOf(content: unknown, imagePlaceholder: () => string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Block[]) {
    if (block?.type === "text" && block.text) parts.push(block.text);
    else if (block?.type === "image") parts.push(imagePlaceholder());
  }
  return parts.join("\n");
}

function messageLines(
  message: AgentMessage,
  options: TranscriptOptions,
  images: { n: number },
): Line[] {
  const m = message as { role?: string; timestamp?: number } & Record<string, unknown>;
  const ts = typeof m.timestamp === "number" ? m.timestamp : Date.now();
  const date = formatDate(ts, options.timeZone);
  const time = formatTime(ts, options.timeZone);
  const lines: Line[] = [];
  const push = (title: string, body: string, alwaysShowTime = false) => {
    if (!body) return;
    lines.push({ date, time, title, body, alwaysShowTime });
  };
  const image = () => `[Image #${images.n++}]`;

  switch (m.role) {
    case "user":
      push("User", textOf(m.content, image));
      break;
    case "assistant": {
      const reasoningMax = options.reasoningMaxChars ?? DEFAULT_REASONING_MAX_CHARS;
      for (const block of (m.content as Block[] | undefined) ?? []) {
        if (block.type === "text") push("Assistant", block.text ?? "");
        else if (block.type === "thinking" && !block.redacted && block.thinking) {
          const thinking = block.thinking;
          push(
            "Reasoning",
            thinking.length > reasoningMax
              ? `${thinking.slice(0, reasoningMax)}… [truncated]`
              : thinking,
          );
        } else if (block.type === "toolCall")
          push(`Tool Call ${block.name ?? "unknown"}`, formatToolArguments(block.arguments), true);
      }
      break;
    }
    case "toolResult": {
      const body = textOf(m.content, image);
      const capped = truncateByTokens(body || "[empty result]", options.toolResultMaxTokens);
      push(`${m.isError ? "Tool Error" : "Tool Result"} ${String(m.toolName ?? "")}`, capped, true);
      break;
    }
    case "bashExecution": {
      const output = truncateByTokens(String(m.output ?? ""), options.toolResultMaxTokens);
      push("User Shell", `$ ${String(m.command ?? "")}\n${output}`.trim(), true);
      break;
    }
    case "custom":
      push(`Custom ${String(m.customType ?? "message")}`, textOf(m.content, image));
      break;
    default:
      // compaction and branch summaries are not observed: they are already summaries.
      break;
  }
  return lines;
}

/** Whether a message is something the observer should see. */
export function isObservableMessage(message: AgentMessage): boolean {
  const role = (message as { role?: string }).role;
  if (role === "bashExecution")
    return !(message as { excludeFromContext?: boolean }).excludeFromContext;
  return (
    role === "user" ||
    role === "assistant" ||
    role === "toolResult" ||
    role === "custom" ||
    role === "bashExecution"
  );
}

export function formatTranscript(
  messages: readonly AgentMessage[],
  options: TranscriptOptions,
): string {
  const images = { n: 1 };
  const out: string[] = [];
  let previousDate: string | undefined;
  let previousTime: string | undefined;
  for (const message of messages) {
    for (const line of messageLines(message, options, images)) {
      if (line.date !== previousDate) {
        out.push(`${line.date}:`);
        previousDate = line.date;
        previousTime = undefined;
      }
      const showTime = line.alwaysShowTime || line.time !== previousTime;
      out.push(`${line.title}${showTime ? ` (${line.time})` : ""}: ${line.body}`);
      previousTime = line.time;
    }
  }
  return out.join("\n");
}
