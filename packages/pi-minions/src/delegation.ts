import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ResolvedDelegationConfig } from "./config.js";

const DEFAULT_HINT_TEMPLATE =
  "\n\nDELEGATION REMINDER: You have made {toolCallCount} tool calls. " +
  "The pi-minions extension is active." +
  "\nUse the `spawn` tool when you intend to wait. Use `orchestrate` for background work that should not block this turn." +
  "\nFor parallel foreground waits, pass a `tasks` array to `spawn`. For background fleets, pass `tasks` to `orchestrate` with a required `description` on each." +
  "\nUse `learn_minions` if you need the full contract, then continue the user's task normally.\n";

export function createDelegationHint(
  toolCallCount: number,
  config: Pick<ResolvedDelegationConfig, "message" | "acknowledgementRequired">,
): string {
  const template = config.message?.trim() ? config.message : DEFAULT_HINT_TEMPLATE;
  const hint = template.replaceAll("{toolCallCount}", String(toolCallCount));

  return hint;
}

export function buildPromptFromContext(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "user" && typeof msg.content === "string") {
      return msg.content;
    }
  }

  return "";
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
  if (
    Number.isFinite(config.promptLengthThreshold) &&
    config.promptLengthThreshold > 0 &&
    prompt.length >= config.promptLengthThreshold
  ) {
    return true;
  }

  const escapedKeywords = config.complexTaskKeywords
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  if (escapedKeywords.length === 0 || !prompt.trim()) return false;

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
