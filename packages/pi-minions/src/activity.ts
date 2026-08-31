import { formatToolCall } from "./render.js";
import type { AgentTree } from "./tree.js";
import type { ActivityPhase, ActivitySnapshot, TrustedActivityProjection } from "./types.js";

/** Modest in-memory ring. Full JSONL transcript remains canonical. */
export const ACTIVITY_HISTORY_CAP = 24;
export const ACTIVITY_SUMMARY_MAX = 120;
export const NARRATIVE_PREVIEW_MAX = 80;

export type ActivityEvent =
  | { type: "starting" }
  | { type: "thinking" }
  | { type: "tool_start"; toolName: string; args?: Record<string, unknown> }
  | { type: "tool_end" }
  | { type: "settling" }
  | { type: "turn_end"; turn: number }
  | { type: "narrative"; text: string };

export interface ReduceActivityResult {
  snapshot: ActivitySnapshot;
  recordHistory: boolean;
}

const TERMINAL_STRING_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal string commands through BEL/ST or end-of-input
  /(?:\u001B(?:\]|P|X|\^|_)|[\u0090\u0098\u009D-\u009F])[\s\S]*?(?:\u0007|\u001B\\|\u009C|$)/g;
const ANSI_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip non-string ANSI escape sequences from untrusted text
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip remaining C0/C1 controls
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

function replaceUnpairedSurrogates(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += text[index] + text[index + 1];
        index++;
      } else {
        result += "�";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "�";
    } else {
      result += text[index];
    }
  }
  return result;
}

export function sanitizeActivityText(text: string, max: number): string {
  const stripped = replaceUnpairedSurrogates(text)
    .replace(TERMINAL_STRING_SEQUENCE, "")
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= max) return stripped;
  if (max <= 0) return "";
  if (max === 1) return "…";

  const budget = max - 1;
  let prefix = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(stripped)) {
    if (prefix.length + segment.length > budget) break;
    prefix += segment;
  }
  return `${prefix}…`;
}

export function formatToolActivity(
  toolName: string,
  args: Record<string, unknown> = {},
): { toolName: string; toolPreview: string; summary: string } {
  const toolPreview = sanitizeActivityText(formatToolCall(toolName, args), ACTIVITY_SUMMARY_MAX);
  return {
    toolName,
    toolPreview,
    summary: sanitizeActivityText(`→ ${toolPreview}`, ACTIVITY_SUMMARY_MAX),
  };
}

export function cloneActivitySnapshot(snapshot: ActivitySnapshot): ActivitySnapshot {
  return { ...snapshot };
}

export function freezeActivitySnapshot(snapshot: ActivitySnapshot): ActivitySnapshot {
  return Object.freeze(cloneActivitySnapshot(snapshot));
}

/** Fleet-facing projection: phase/summary/safe tool preview/turn/updatedAt only. */
export function projectTrustedActivity(snapshot: ActivitySnapshot): TrustedActivityProjection {
  const projected: TrustedActivityProjection = {
    phase: snapshot.phase,
    summary: snapshot.summary,
    updatedAt: snapshot.updatedAt,
  };
  if (snapshot.toolPreview) projected.toolPreview = snapshot.toolPreview;
  if (snapshot.turn !== undefined) projected.turn = snapshot.turn;
  return Object.freeze(projected);
}

function carryTurn(
  current: ActivitySnapshot | undefined,
  event: ActivityEvent,
): number | undefined {
  return event.type === "turn_end" ? event.turn : current?.turn;
}

function withMeta(
  current: ActivitySnapshot | undefined,
  event: ActivityEvent,
  now: number,
  rest: Omit<ActivitySnapshot, "turn" | "updatedAt">,
): ActivitySnapshot {
  return {
    ...rest,
    turn: carryTurn(current, event),
    updatedAt: now,
  };
}

function keepCurrent(
  current: ActivitySnapshot,
  event: ActivityEvent,
  now: number,
): ReduceActivityResult {
  return {
    snapshot: { ...current, turn: carryTurn(current, event), updatedAt: now },
    recordHistory: false,
  };
}

export function reduceActivity(
  current: ActivitySnapshot | undefined,
  event: ActivityEvent,
  now: number,
): ReduceActivityResult {
  switch (event.type) {
    case "starting":
      return {
        snapshot: withMeta(current, event, now, { phase: "starting", summary: "starting" }),
        recordHistory: current?.phase !== "starting",
      };
    case "thinking": {
      if (current?.phase === "tool") return keepCurrent(current, event, now);
      if (current?.phase === "thinking") return keepCurrent(current, event, now);
      return {
        snapshot: withMeta(current, event, now, {
          phase: "thinking",
          summary: "thinking",
          narrativePreview: current?.narrativePreview,
        }),
        recordHistory: true,
      };
    }
    case "tool_start": {
      const formatted = formatToolActivity(event.toolName, event.args);
      return {
        snapshot: withMeta(current, event, now, {
          phase: "tool",
          summary: formatted.summary,
          toolName: event.toolName,
          toolPreview: formatted.toolPreview,
        }),
        recordHistory: true,
      };
    }
    case "tool_end": {
      if (current?.phase === "settling") return keepCurrent(current, event, now);
      const keepTool = current?.phase === "tool";
      return {
        snapshot: withMeta(current, event, now, {
          phase: "thinking",
          summary: keepTool && current?.summary ? current.summary : "thinking",
          toolName: keepTool ? current?.toolName : undefined,
          toolPreview: keepTool ? current?.toolPreview : undefined,
          narrativePreview: current?.narrativePreview,
        }),
        recordHistory: current?.phase !== "thinking",
      };
    }
    case "settling":
      return {
        snapshot: withMeta(current, event, now, { phase: "settling", summary: "settling" }),
        recordHistory: current?.phase !== "settling",
      };
    case "turn_end":
      return {
        snapshot: {
          phase: current?.phase ?? "thinking",
          summary: current?.summary ?? "thinking",
          toolName: current?.toolName,
          toolPreview: current?.toolPreview,
          narrativePreview: current?.narrativePreview,
          turn: event.turn,
          updatedAt: now,
        },
        recordHistory: false,
      };
    case "narrative": {
      const narrativePreview = sanitizeActivityText(event.text, NARRATIVE_PREVIEW_MAX);
      if (!current) {
        return {
          snapshot: withMeta(current, event, now, {
            phase: "thinking",
            summary: "thinking",
            narrativePreview,
          }),
          recordHistory: false,
        };
      }
      return {
        snapshot: { ...current, narrativePreview, updatedAt: now },
        recordHistory: false,
      };
    }
  }
}

export function capActivityHistory(history: ActivitySnapshot[]): ActivitySnapshot[] {
  if (history.length <= ACTIVITY_HISTORY_CAP) return history;
  return history.slice(-ACTIVITY_HISTORY_CAP);
}

export function replayActivity(
  events: ActivityEvent[],
  now = Date.now(),
): { current: ActivitySnapshot | undefined; history: ActivitySnapshot[] } {
  let current: ActivitySnapshot | undefined;
  const history: ActivitySnapshot[] = [];
  for (const event of events) {
    const result = reduceActivity(current, event, now);
    current = freezeActivitySnapshot(result.snapshot);
    if (result.recordHistory) {
      history.push(current);
      if (history.length > ACTIVITY_HISTORY_CAP) history.shift();
    }
  }
  return { current, history };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function messageFromRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (record.type !== "message") return undefined;
  return asRecord(record.message);
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block) blocks.push(block);
  }
  return blocks;
}

function toolCallFromBlock(
  block: Record<string, unknown>,
): { id: string; toolName: string; args: Record<string, unknown> } | undefined {
  if (block.type !== "toolCall") return undefined;
  const id = typeof block.id === "string" ? block.id : "";
  const toolName = typeof block.name === "string" ? block.name : "";
  if (!id || !toolName) return undefined;
  return { id, toolName, args: asRecord(block.arguments) ?? {} };
}

/** One persisted SessionManager record. Live tool_execution events are not JSONL. */
export function activityEventsFromSessionRecord(record: Record<string, unknown>): ActivityEvent[] {
  return sessionRecordsToActivityEvents([record]);
}

/**
 * Replay actual Pi SessionManager JSONL: type=message assistant toolCall blocks
 * paired to toolResult records by toolCallId. Unmatched/malformed calls never wait.
 */
export function sessionRecordsToActivityEvents(
  records: Record<string, unknown>[],
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const pendingCalls = new Set<string>();
  const quarantinedCallIds = new Set<string>();
  let turnCount = 0;

  for (const record of records) {
    const message = messageFromRecord(record);
    if (!message) continue;

    if (message.role === "assistant") {
      turnCount++;
      events.push({ type: "turn_end", turn: turnCount });

      if (typeof message.content === "string") {
        if (message.content.trim()) events.push({ type: "thinking" });
        continue;
      }

      for (const block of contentBlocks(message.content)) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          events.push({ type: "thinking" });
        }
        const call = toolCallFromBlock(block);
        if (!call) continue;
        if (quarantinedCallIds.has(call.id) || pendingCalls.has(call.id)) {
          pendingCalls.delete(call.id);
          quarantinedCallIds.add(call.id);
          continue;
        }
        events.push({ type: "tool_start", toolName: call.toolName, args: call.args });
        pendingCalls.add(call.id);
      }
      continue;
    }

    if (message.role !== "toolResult") continue;

    const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
    if (!callId || quarantinedCallIds.has(callId)) continue;
    if (!pendingCalls.delete(callId)) continue;
    events.push({ type: "tool_end" });
  }

  return events;
}

/** Skip malformed/truncated lines; later valid records still replay. */
export function parseJsonlRecords(content: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const raw of content.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const record = asRecord(parsed);
      if (record) records.push(record);
    } catch {}
  }
  return records;
}

export function lastNarrativeLine(text: string): string {
  return text.split("\n").filter(Boolean).at(-1) ?? "";
}

export function bindTreeActivity(
  tree: AgentTree,
  id: string,
  lifecycleId?: string,
  ownsLifecycle?: () => boolean,
): {
  onToolActivity: (activity: {
    type: "start" | "end";
    toolName: string;
    args?: Record<string, unknown>;
  }) => void;
  onToolOutput: (toolName: string, delta: string) => void;
  onTextDelta: (delta: string, fullText: string) => void;
  onTurnEnd: (turnCount: number) => void;
  onAgentEnd: (info?: { willRetry?: boolean }) => void;
} {
  const isCurrent = (): boolean =>
    (lifecycleId === undefined || tree.get(id)?.lifecycleId === lifecycleId) &&
    (ownsLifecycle === undefined || ownsLifecycle());
  return {
    onToolActivity: (activity) => {
      if (!isCurrent()) return;
      if (activity.type === "start") {
        tree.applyActivityEvent(id, {
          type: "tool_start",
          toolName: activity.toolName,
          args: activity.args,
        });
        return;
      }
      tree.applyActivityEvent(id, { type: "tool_end" });
    },
    onToolOutput: (_toolName, delta) => {
      if (!isCurrent()) return;
      const line = lastNarrativeLine(delta.trimEnd());
      if (line) tree.applyActivityEvent(id, { type: "narrative", text: line });
    },
    onTextDelta: (_delta, fullText) => {
      if (!isCurrent()) return;
      const events: ActivityEvent[] = [{ type: "thinking" }];
      const preview = lastNarrativeLine(fullText);
      if (preview) events.push({ type: "narrative", text: preview });
      tree.applyActivityEvents(id, events);
    },
    onTurnEnd: (turnCount) => {
      if (!isCurrent()) return;
      tree.applyActivityEvent(id, { type: "turn_end", turn: turnCount });
      tree.updateUsage(id, { turns: turnCount });
    },
    onAgentEnd: (info) => {
      if (!isCurrent() || info?.willRetry) return;
      tree.applyActivityEvent(id, { type: "settling" });
    },
  };
}

export function isActivityPhase(value: string): value is ActivityPhase {
  return value === "starting" || value === "thinking" || value === "tool" || value === "settling";
}
