import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ResolvedDelegationConfig } from "./config.js";

const DEFAULT_HINT_TEMPLATE =
  "\n\nDELEGATION REMINDER: You have made: {toolCallCount} tool calls. " +
  "The pi-minions extension is active and provides tools for parallel execution and work delegation." +
  "\nDELEGATE independent subtasks to minions for faster, isolated processing using the `spawn` and `spawn_bg` tools." +
  "\nUSE any delegation skills you have available through the system.\n" +
  "\nALWAYS acknowledge this reminder when you receive it and review your delegation strategy before making further tool calls.\n";

export function createDelegationHint(
  toolCallCount: number,
  config: Pick<ResolvedDelegationConfig, "message" | "acknowledgementRequired">,
): string {
  const template = config.message?.trim() ? config.message : DEFAULT_HINT_TEMPLATE;
  const hint = template.replaceAll("{toolCallCount}", String(toolCallCount));

  if (!config.acknowledgementRequired || hint.includes("ALWAYS acknowledge this reminder")) {
    return hint;
  }

  return `${hint}\nALWAYS acknowledge this reminder when you receive it and review your delegation strategy before making further tool calls.\n`;
}

export function buildPromptFromContext(messages: AgentMessage[]): string {
  return messages
    .filter((msg) => msg.role === "user")
    .map((msg) => (typeof msg.content === "string" ? msg.content : ""))
    .join("\n");
}

export function isComplexDelegationTask(opts: {
  toolCallCount: number;
  prompt: string;
  config: Pick<
    ResolvedDelegationConfig,
    "toolCallThreshold" | "promptLengthThreshold" | "complexTaskKeywords"
  >;
}): boolean {
  const { toolCallCount, prompt, config } = opts;
  if (toolCallCount >= config.toolCallThreshold) return true;
  if (prompt.length >= config.promptLengthThreshold) return true;

  const escapedKeywords = config.complexTaskKeywords
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  if (escapedKeywords.length === 0) return false;

  return new RegExp(`\\b(${escapedKeywords.join("|")})\\b`, "i").test(prompt);
}

export function shouldInjectDelegationHint(opts: {
  usedMinionsThisSession: boolean;
  isComplexTask: boolean;
  now: number;
  lastHintTime: number;
  hintIntervalMinutes: number;
}): boolean {
  if (opts.usedMinionsThisSession || !opts.isComplexTask) return false;
  return opts.now - opts.lastHintTime > opts.hintIntervalMinutes * 60_000;
}
