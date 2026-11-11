import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

import { countTokens } from "./tokens.js";
import { formatTranscript, truncateByTokens } from "./transcript.js";

export const RECALL_MAX_TOKENS = 20_000;
const RECALL_TOOL_RESULT_MAX_TOKENS = 8_000;

interface MessageEntry {
  id: string;
  messages: AgentMessage[];
}

function messageEntries(branch: readonly SessionEntry[]): MessageEntry[] {
  const out: MessageEntry[] = [];
  for (const entry of branch) {
    if (entry.type !== "message" && entry.type !== "custom_message") continue;
    const messages = sessionEntryToContextMessages(entry);
    if (messages.length > 0) out.push({ id: entry.id, messages });
  }
  return out;
}

function render(entries: readonly MessageEntry[]): string {
  const blocks = entries.map(
    (entry) =>
      `[entry ${entry.id}]\n${formatTranscript(entry.messages, { toolResultMaxTokens: RECALL_TOOL_RESULT_MAX_TOKENS, reasoningMaxChars: 4_000 })}`,
  );
  const text = blocks.join("\n\n");
  return countTokens(text) > RECALL_MAX_TOKENS ? truncateByTokens(text, RECALL_MAX_TOKENS) : text;
}

/** Raw history for an observation group range `first:last` (inclusive, branch order). */
export function recallRange(branch: readonly SessionEntry[], range: string): string {
  const [first, last] = range.split(":").map((part) => part.trim());
  const entries = messageEntries(branch);
  const start = entries.findIndex((entry) => entry.id === first);
  const end = last ? entries.findIndex((entry) => entry.id === last) : start;
  if (start < 0 || end < start) return `No entries found for range ${range} on the current branch.`;
  return render(entries.slice(start, end + 1));
}

/** Case-insensitive substring search over raw history, with one neighbour of context. */
export function recallSearch(branch: readonly SessionEntry[], query: string, limit = 5): string {
  const needle = query.toLowerCase();
  const entries = messageEntries(branch);
  const hits: number[] = [];
  for (let index = entries.length - 1; index >= 0 && hits.length < limit; index -= 1) {
    const text = formatTranscript(entries[index]!.messages, {
      toolResultMaxTokens: RECALL_TOOL_RESULT_MAX_TOKENS,
    }).toLowerCase();
    if (text.includes(needle)) hits.push(index);
  }
  if (hits.length === 0) return `No raw history matches "${query}".`;
  const selected = new Set<number>();
  for (const index of hits) {
    for (const neighbour of [index - 1, index, index + 1]) {
      if (neighbour >= 0 && neighbour < entries.length) selected.add(neighbour);
    }
  }
  return render([...selected].sort((a, b) => a - b).map((index) => entries[index]!));
}
