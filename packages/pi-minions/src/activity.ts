import { formatToolCall } from "./render.js";
import type { AgentTree } from "./tree.js";
import type { ActivityPhase, ActivitySnapshot } from "./types.js";

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
      return {
        snapshot: withMeta(current, event, now, {
          phase: "thinking",
          summary: "thinking",
          narrativePreview: current?.narrativePreview,
        }),
        recordHistory: current?.phase !== "thinking",
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
        return {
          snapshot: { ...current, turn: carryTurn(current, event), updatedAt: now },
          recordHistory: false,
        };
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
      if (current?.phase === "waiting") {
        return {
          snapshot: { ...current, turn: carryTurn(current, event), updatedAt: now },
          recordHistory: false,
        };
      }
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
    current = result.snapshot;
    if (result.recordHistory) {
      history.push(current);
      if (history.length > ACTIVITY_HISTORY_CAP) history.shift();
    }
  }
  return { current, history };
}

export function activityEventsFromSessionRecord(event: Record<string, unknown>): ActivityEvent[] {
  if (event.type === "tool_execution_start") {
    const toolName = String(event.toolName ?? "");
    const args = (event.args ?? {}) as Record<string, unknown>;
    const events: ActivityEvent[] = [{ type: "tool_start", toolName, args }];
    if (toolName === "send_minion_peer" && String(args.to ?? "") === "parent") {
      events.push({ type: "waiting" });
    }
    return events;
  }
  if (event.type === "tool_execution_end") return [{ type: "tool_end" }];
  if (event.type === "agent_end" && event.willRetry !== true) return [{ type: "settling" }];
  return [];
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
