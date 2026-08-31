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
  | { type: "waiting" }
  | { type: "settling" }
  | { type: "turn_end"; turn: number }
  | { type: "narrative"; text: string };

export interface ReduceActivityResult {
  snapshot: ActivitySnapshot;
  recordHistory: boolean;
}

const ANSI_AND_OSC =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control sequences from untrusted text
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip remaining C0/C1 controls
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

const FAILED_SEND_STATUSES = new Set([
  "recipient-terminal",
  "invalid-recipient",
  "group-not-open",
  "mailbox-full",
  "body-too-large",
]);

export function sanitizeActivityText(text: string, max: number): string {
  const stripped = text
    .replace(ANSI_AND_OSC, "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= max) return stripped;
  const budget = Math.max(1, max - 1);
  return `${stripped.slice(0, budget)}…`;
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
    case "thinking":
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
      if (current?.phase === "waiting" || current?.phase === "settling") {
        return keepCurrent(current, event, now);
      }
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
    case "waiting":
      return {
        snapshot: withMeta(current, event, now, {
          phase: "waiting",
          summary: "waiting on parent",
        }),
        recordHistory: current?.phase !== "waiting",
      };
    case "settling":
      if (current?.phase === "waiting") return keepCurrent(current, event, now);
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

function evidenceBags(event: Record<string, unknown>): Record<string, unknown>[] {
  const bags = [event];
  const args = asRecord(event.args);
  if (args) bags.push(args);
  const result = asRecord(event.result);
  if (result) {
    bags.push(result);
    const nested = asRecord(result.details);
    if (nested) bags.push(nested);
  }
  const details = asRecord(event.details);
  if (details) bags.push(details);
  return bags;
}

function evidenceString(bags: Record<string, unknown>[], key: string): string | undefined {
  for (const bag of bags) {
    const value = bag[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function toolEndFailed(event: Record<string, unknown>): boolean {
  if (event.isError === true || event.success === false) return true;
  const result = asRecord(event.result);
  if (result?.isError === true) return true;
  const status = evidenceString(evidenceBags(event), "status");
  return status !== undefined && FAILED_SEND_STATUSES.has(status);
}

function isAcceptedParentBoundQuestion(
  event: Record<string, unknown>,
  pendingParentQuestion: boolean,
): boolean {
  if (toolEndFailed(event)) return false;
  const bags = evidenceBags(event);
  const to = evidenceString(bags, "to");
  const status = evidenceString(bags, "status");
  const toolName = String(event.toolName ?? "");
  const parentBound =
    pendingParentQuestion ||
    to === "parent" ||
    (toolName === "send_minion_peer" && to === "parent");
  if (!parentBound) return false;
  if (to !== undefined && to !== "parent") return false;
  if (status !== undefined && status !== "queued") return false;
  if (status === "queued") return true;
  return pendingParentQuestion;
}

function isParentBoundPeerStart(toolName: string, args: Record<string, unknown>): boolean {
  return toolName === "send_minion_peer" && String(args.to ?? "") === "parent";
}

/** One record. Waiting requires accepted parent-bound evidence, never a mere start. */
export function activityEventsFromSessionRecord(event: Record<string, unknown>): ActivityEvent[] {
  if (event.type === "tool_execution_start") {
    const toolName = String(event.toolName ?? "");
    const args = (event.args ?? {}) as Record<string, unknown>;
    return [{ type: "tool_start", toolName, args }];
  }
  if (event.type === "tool_execution_end") {
    const events: ActivityEvent[] = [{ type: "tool_end" }];
    if (isAcceptedParentBoundQuestion(event, false)) events.push({ type: "waiting" });
    return events;
  }
  if (event.type === "agent_end" && event.willRetry !== true) return [{ type: "settling" }];
  return [];
}

/** Ordered transcript replay. Pairs send start/end; skips uncertainty. */
export function sessionRecordsToActivityEvents(
  records: Record<string, unknown>[],
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  let pendingParentQuestion = false;
  let turnCount = 0;
  for (const event of records) {
    if (event.type === "turn_end") {
      turnCount++;
      events.push({ type: "turn_end", turn: turnCount });
      pendingParentQuestion = false;
      continue;
    }
    if (event.type === "tool_execution_start") {
      const toolName = String(event.toolName ?? "");
      const args = (asRecord(event.args) ?? {}) as Record<string, unknown>;
      events.push({ type: "tool_start", toolName, args });
      pendingParentQuestion = isParentBoundPeerStart(toolName, args);
      continue;
    }
    if (event.type === "tool_execution_end") {
      events.push({ type: "tool_end" });
      if (isAcceptedParentBoundQuestion(event, pendingParentQuestion)) {
        events.push({ type: "waiting" });
      }
      pendingParentQuestion = false;
      continue;
    }
    pendingParentQuestion = false;
    events.push(...activityEventsFromSessionRecord(event));
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
  return {
    onToolActivity: (activity) => {
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
      const line = lastNarrativeLine(delta.trimEnd());
      if (line) tree.applyActivityEvent(id, { type: "narrative", text: line });
    },
    onTextDelta: (_delta, fullText) => {
      tree.applyActivityEvent(id, { type: "thinking" });
      const preview = lastNarrativeLine(fullText);
      if (preview) tree.applyActivityEvent(id, { type: "narrative", text: preview });
    },
    onTurnEnd: (turnCount) => {
      tree.applyActivityEvent(id, { type: "turn_end", turn: turnCount });
      tree.updateUsage(id, { turns: turnCount });
    },
    onAgentEnd: (info) => {
      if (info?.willRetry) return;
      tree.applyActivityEvent(id, { type: "settling" });
    },
  };
}

export function isActivityPhase(value: string): value is ActivityPhase {
  return (
    value === "starting" ||
    value === "thinking" ||
    value === "tool" ||
    value === "waiting" ||
    value === "settling"
  );
}
