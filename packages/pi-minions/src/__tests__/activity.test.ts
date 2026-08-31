import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_HISTORY_CAP,
  bindTreeActivity,
  formatToolActivity,
  NARRATIVE_PREVIEW_MAX,
  parseJsonlRecords,
  reduceActivity,
  replayActivity,
  sanitizeActivityText,
  sessionRecordsToActivityEvents,
} from "../activity.js";
import { logger } from "../logger.js";
import {
  COMM_SEND_STATUS,
  createLifecyclePacketDispatcher,
  type LifecyclePacketDetails,
  MinionCommMailbox,
  OrchestrationGroupState,
  PARENT_RECIPIENT_ID,
} from "../orchestration/index.js";
import { EventBus, MINION_COMPLETE_CHANNEL } from "../subsessions/event-bus.js";
import { SubsessionManager } from "../subsessions/manager.js";
import type {
  ChildSession,
  ChildSessionEvent,
  CreateMinionSessionOptions,
} from "../subsessions/types.js";
import { AgentTree } from "../tree.js";
import type { ActivitySnapshot, AgentConfig, ThinkingLevel } from "../types.js";

const NOW = 1_700_000_000_000;

function summaries(history: ActivitySnapshot[] | undefined): string[] {
  return (history ?? []).map((item) => item.summary);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

class FakeChildSession implements ChildSession {
  tools = new Map<string, { name: string }>([["read", { name: "read" }]]);
  active = new Set(["read"]);
  listeners = new Set<(event: ChildSessionEvent) => void>();
  disposed = false;
  isStreaming = false;
  prompts: string[] = [];
  followUps: string[] = [];
  state = { messages: [] as unknown[] };

  async bindExtensions(): Promise<void> {}
  setThinkingLevel(_level: ThinkingLevel): void {}
  setActiveToolsByName(toolNames: string[]): void {
    this.active = new Set(toolNames.filter((name) => this.tools.has(name)));
  }
  getAllTools(): Array<{ name: string }> {
    return [...this.tools.values()];
  }
  getActiveToolNames(): string[] {
    return [...this.active];
  }
  subscribe(listener: (event: ChildSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event: ChildSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
  abort(): void {}
  async steer(): Promise<void> {}
  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
  }
  async waitForIdle(): Promise<void> {}
  dispose(): void {
    this.disposed = true;
  }
  getSessionStats() {
    return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
  }
}

const config: AgentConfig = {
  name: "worker",
  description: "test",
  systemPrompt: "do the work",
  source: "builtin",
  filePath: "builtin:worker",
};

describe("activity reducer phases", () => {
  it("transitions starting → thinking → tool → thinking → settling", () => {
    let snap: ActivitySnapshot | undefined;
    const apply = (event: Parameters<typeof reduceActivity>[1]) => {
      snap = reduceActivity(snap, event, NOW).snapshot;
      return snap;
    };

    expect(apply({ type: "starting" })).toMatchObject({ phase: "starting", summary: "starting" });
    expect(apply({ type: "thinking" })).toMatchObject({ phase: "thinking", summary: "thinking" });
    expect(
      apply({ type: "tool_start", toolName: "read", args: { path: "src/auth.ts" } }),
    ).toMatchObject({
      phase: "tool",
      summary: "→ read src/auth.ts",
      toolName: "read",
      toolPreview: "read src/auth.ts",
    });
    expect(apply({ type: "tool_end" })).toMatchObject({
      phase: "thinking",
      summary: "→ read src/auth.ts",
    });
    expect(apply({ type: "settling" }).phase).toBe("settling");
  });

  it("does not let a late thinking event overwrite an active tool", () => {
    const tool = reduceActivity(
      undefined,
      { type: "tool_start", toolName: "read", args: { path: "src/auth.ts" } },
      NOW,
    ).snapshot;
    const next = reduceActivity(tool, { type: "thinking" }, NOW + 1).snapshot;
    expect(next.phase).toBe("tool");
    expect(next.summary).toBe("→ read src/auth.ts");
  });

  it("uses formatToolCall-quality previews for bash and read", () => {
    expect(formatToolActivity("read", { path: "src/tree.ts" }).summary).toBe("→ read src/tree.ts");
    expect(formatToolActivity("bash", { command: "npm test" }).summary).toBe("→ $ npm test");
  });

  it("sanitizes ANSI, control, and multiline tool args through the real formatter", () => {
    const dirty = formatToolActivity("bash", {
      command: "\u001B[31mecho hi\u001B[0m\r\nsecond line\u0007",
    });
    expect(dirty.summary.includes("\n")).toBe(false);
    expect(dirty.summary.includes("\r")).toBe(false);
    expect(dirty.summary.includes("\u001B")).toBe(false);
    expect(dirty.toolPreview.includes("\n")).toBe(false);
    expect(dirty.summary.startsWith("→ $")).toBe(true);
    expect(dirty.summary.length).toBeLessThanOrEqual(120);
  });

  it("preserves useful phase/summary on turn_end and never records turn N", () => {
    const afterTool = reduceActivity(
      undefined,
      { type: "tool_start", toolName: "read", args: { path: "src/auth.ts" } },
      NOW,
    ).snapshot;
    const afterTurn = reduceActivity(afterTool, { type: "turn_end", turn: 3 }, NOW + 1);
    expect(afterTurn.snapshot.phase).toBe("tool");
    expect(afterTurn.snapshot.summary).toBe("→ read src/auth.ts");
    expect(afterTurn.snapshot.turn).toBe(3);
    expect(afterTurn.recordHistory).toBe(false);
    expect(afterTurn.snapshot.summary).not.toMatch(/turn \d/);
  });

  it("does not let narrative overwrite canonical phase/summary", () => {
    const tool = reduceActivity(
      undefined,
      { type: "tool_start", toolName: "read", args: { path: "src/auth.ts" } },
      NOW,
    ).snapshot;
    const next = reduceActivity(
      tool,
      { type: "narrative", text: "I am going to rewrite auth next" },
      NOW + 1,
    );
    expect(next.snapshot.phase).toBe("tool");
    expect(next.snapshot.summary).toBe("→ read src/auth.ts");
    expect(next.snapshot.narrativePreview).toBe("I am going to rewrite auth next");
    expect(next.recordHistory).toBe(false);
  });
});

describe("sanitization", () => {
  it("strips control sequences and multiline prose so TUI lines stay single-line", () => {
    const dirty = "\u001B[31mred\u001B[0m\r\nsecond line\u0007";
    const cleaned = sanitizeActivityText(dirty, 80);
    expect(cleaned).toBe("red second line");
    expect(cleaned.includes("\n")).toBe(false);
    expect(cleaned.includes("\r")).toBe(false);
    expect(cleaned.includes("\u001B")).toBe(false);
    expect(sanitizeActivityText("a".repeat(200), NARRATIVE_PREVIEW_MAX).endsWith("…")).toBe(true);
  });

  it.each([
    ["OSC/BEL", "before \u001B]8;;https://evil.example\u0007 after"],
    ["OSC/ST", "before \u001B]0;hostile title\u001B\\ after"],
    ["DCS/ST", "before \u001BPcommand\nwith payload\u001B\\ after"],
    ["APC/ST", "before \u001B_private command\u001B\\ after"],
    ["PM/ST", "before \u001B^private message\u001B\\ after"],
    ["SOS/ST", "before \u001BXstart of string\u001B\\ after"],
    ["C1 OSC/ST", "before \u009D8;;https://evil.example\u009C after"],
  ])("strips terminated %s strings while preserving surrounding text", (_label, dirty) => {
    expect(sanitizeActivityText(dirty, 200)).toBe("before after");
  });

  it.each([
    ["OSC", "\u001B]8;;https://evil.example"],
    ["DCS", "\u001BPcommand\nwith payload"],
    ["APC", "\u001B_private command"],
    ["PM", "\u001B^private message"],
    ["SOS", "\u001BXstart of string"],
    ["C1 APC", "\u009Fprivate command"],
  ])("strips unterminated %s payload through end-of-input", (_label, sequence) => {
    const cleaned = sanitizeActivityText(`ordinary text ${sequence}`, 200);
    expect(cleaned).toBe("ordinary text");
    expect(cleaned).not.toMatch(/evil|command|payload|message|string/);
  });

  it.each([
    ["emoji", "😀"],
    ["ZWJ family", "👨‍👩‍👧‍👦"],
    ["flag", "🇺🇳"],
    ["skin tone", "👍🏽"],
    ["combining mark", "e\u0301"],
  ])("truncates %s only after a complete grapheme", (_label, grapheme) => {
    const max = grapheme.length + 1;
    const cleaned = sanitizeActivityText(`A${grapheme}tail`, max);
    expect(cleaned).toBe("A…");
    expect(cleaned.length).toBeLessThanOrEqual(max);
    expect(Buffer.from(cleaned, "utf8").toString("utf8")).toBe(cleaned);
  });

  it("replaces hostile unpaired surrogates before truncation and UTF-8 encoding", () => {
    const cleaned = sanitizeActivityText("A\uD83DB\uDC00C", 80);
    expect(cleaned).toBe("A�B�C");
    expect(Buffer.from(cleaned, "utf8").toString("utf8")).toBe(cleaned);
    expect(cleaned).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});

describe("AgentTree activity", () => {
  it("registers pending as starting and live handle as thinking", () => {
    const tree = new AgentTree();
    const pending = tree.add("mn-pending", "echo", "start me", {
      kind: "orchestrated",
      groupId: "grp-1",
      status: "pending",
    });
    expect(pending.status).toBe("pending");
    expect(pending.activity?.phase).toBe("starting");
    expect(pending.lastActivity).toBe("starting");

    tree.markLiveHandle("mn-pending");
    expect(tree.get("mn-pending")?.status).toBe("running");
    expect(tree.get("mn-pending")?.activity?.phase).toBe("thinking");
    expect(tree.get("mn-pending")?.lastActivity).toBe("thinking");
  });

  it("does not let spawn or orchestrate live-handle thinking clobber a started tool", () => {
    const tree = new AgentTree();
    tree.add("mn-spawn", "alpha", "read the file");
    tree.applyActivityEvent("mn-spawn", {
      type: "tool_start",
      toolName: "read",
      args: { path: "src/auth.ts" },
    });
    tree.markLiveHandle("mn-spawn");
    expect(tree.get("mn-spawn")?.status).toBe("running");
    expect(tree.get("mn-spawn")?.activity?.phase).toBe("tool");
    expect(tree.get("mn-spawn")?.lastActivity).toBe("→ read src/auth.ts");

    tree.add("mn-orch", "bravo", "read the file", {
      kind: "orchestrated",
      groupId: "grp-1",
      status: "pending",
    });
    tree.applyActivityEvent("mn-orch", {
      type: "tool_start",
      toolName: "read",
      args: { path: "src/auth.ts" },
    });
    tree.markLiveHandle("mn-orch");
    expect(tree.get("mn-orch")?.status).toBe("running");
    expect(tree.get("mn-orch")?.activity?.phase).toBe("tool");
    expect(tree.get("mn-orch")?.lastActivity).toBe("→ read src/auth.ts");
  });

  it("notifies once for a batched thinking and narrative text event", () => {
    const tree = new AgentTree();
    tree.add("mn-1", "alpha", "work");
    const phases: string[] = [];
    tree.onChange(() => {
      phases.push(tree.get("mn-1")?.activity?.phase ?? "");
    });
    tree.applyActivityEvents("mn-1", [{ type: "thinking" }, { type: "narrative", text: "hello" }]);
    expect(phases).toEqual(["thinking"]);
    expect(tree.get("mn-1")?.activity?.narrativePreview).toBe("hello");
    expect(tree.listenerCount()).toBe(1);
  });

  it("does not alias current activity with history tail", () => {
    const tree = new AgentTree();
    tree.add("mn-1", "alpha", "work");
    tree.applyActivityEvent("mn-1", {
      type: "tool_start",
      toolName: "read",
      args: { path: "src/auth.ts" },
    });
    const node = tree.get("mn-1")!;
    const current = node.activity!;
    const tail = node.activityHistory.at(-1)!;
    expect(current).not.toBe(tail);
    expect(current).toEqual(tail);
    current.summary = "mutated";
    expect(tail.summary).toBe("→ read src/auth.ts");
    expect(tree.get("mn-1")?.activity?.summary).toBe("mutated");
    expect(tree.get("mn-1")?.lastActivity).toBe("→ read src/auth.ts");
  });

  it("shows a bounded formatted read path instead of turn N", () => {
    const tree = new AgentTree();
    tree.add("mn-1", "alpha", "read the file");
    const bound = bindTreeActivity(tree, "mn-1");
    bound.onToolActivity({ type: "start", toolName: "read", args: { path: "src/auth.ts" } });
    bound.onTurnEnd(3);
    const node = tree.get("mn-1")!;
    expect(node.status).toBe("running");
    expect(node.activity?.phase).toBe("tool");
    expect(node.activity?.summary).toBe("→ read src/auth.ts");
    expect(node.activity?.turn).toBe(3);
    expect(node.lastActivity).not.toMatch(/turn \d/);
    expect(summaries(node.activityHistory).some((line) => /turn \d/.test(line))).toBe(false);
    expect(node.usage.turns).toBe(3);
  });

  it("caps recent activity history at the fixed modest cap", () => {
    const tree = new AgentTree();
    tree.add("mn-1", "alpha", "many tools");
    for (let i = 0; i < ACTIVITY_HISTORY_CAP + 10; i++) {
      tree.applyActivityEvent("mn-1", {
        type: "tool_start",
        toolName: "read",
        args: { path: `src/file-${i}.ts` },
      });
    }
    const history = tree.get("mn-1")?.activityHistory ?? [];
    expect(history.length).toBe(ACTIVITY_HISTORY_CAP);
    expect(history[0]?.summary).toBe("→ read src/file-10.ts");
    expect(history.at(-1)?.summary).toBe(`→ read src/file-${ACTIVITY_HISTORY_CAP + 9}.ts`);
  });

  it("terminal status stays authoritative outside the activity snapshot", () => {
    const tree = new AgentTree();
    tree.add("mn-1", "alpha", "done");
    tree.applyActivityEvent("mn-1", {
      type: "tool_start",
      toolName: "read",
      args: { path: "src/auth.ts" },
    });
    tree.updateStatus("mn-1", "completed", 0);
    expect(tree.get("mn-1")?.status).toBe("completed");
    expect(tree.get("mn-1")?.activity?.phase).toBe("tool");
    tree.updateStatus("mn-1", "failed", 1, "nope");
    expect(tree.get("mn-1")?.status).toBe("completed");
  });

  it("isolates a throwing global listener and still delivers later global and node listeners once", () => {
    const tree = new AgentTree();
    tree.add("mn-1", "alpha", "work");
    const order: string[] = [];
    vi.spyOn(logger, "error").mockImplementation(() => {});
    tree.onChange(() => {
      order.push("g1");
      throw new Error("global boom");
    });
    tree.onChange(() => {
      order.push("g2");
    });
    tree.onNodeChange("mn-1", () => {
      order.push("n1");
    });
    expect(() => tree.applyActivityEvent("mn-1", { type: "thinking" })).not.toThrow();
    expect(order).toEqual(["g1", "g2", "n1"]);
    expect(logger.error).toHaveBeenCalledWith(
      "tree",
      "listener-error",
      expect.objectContaining({ error: "global boom" }),
    );
    vi.restoreAllMocks();
  });

  it("stale unsubscribe after remove/readd keeps the replacement listener", () => {
    const tree = new AgentTree();
    tree.add("mn-1", "alpha", "work");
    const stale: string[] = [];
    const staleUnsub = tree.onNodeChange("mn-1", () => {
      stale.push("old");
    });
    staleUnsub();
    tree.remove("mn-1");
    tree.add("mn-1", "bravo", "work again");
    const hits: string[] = [];
    tree.onNodeChange("mn-1", () => {
      hits.push("new");
    });
    staleUnsub();
    tree.applyActivityEvent("mn-1", { type: "thinking" });
    expect(stale).toEqual([]);
    expect(hits).toEqual(["new"]);
  });

  it("stale unsubscribe of the same callback does not remove the replacement registration", () => {
    const tree = new AgentTree();
    tree.add("mn-1", "alpha", "work");
    const hits: string[] = [];
    const callback = () => {
      hits.push("cb");
    };
    const staleUnsub = tree.onNodeChange("mn-1", callback);
    staleUnsub();
    tree.remove("mn-1");
    tree.add("mn-1", "bravo", "work again");
    tree.onNodeChange("mn-1", callback);
    staleUnsub();
    tree.applyActivityEvent("mn-1", { type: "thinking" });
    expect(hits).toEqual(["cb"]);
    expect(tree.listenerCount()).toBe(1);
  });

  it("explicit global and scoped registrations of the same callback each fire once", () => {
    const tree = new AgentTree();
    tree.add("mn-1", "alpha", "work");
    let hits = 0;
    const callback = () => {
      hits++;
    };
    tree.onChange(callback);
    tree.onNodeChange("mn-1", callback);
    tree.applyActivityEvent("mn-1", { type: "thinking" });
    expect(hits).toBe(2);
  });

  it("contains logger failures and hostile thrown values without skipping later listeners", () => {
    const tree = new AgentTree();
    tree.add("mn-1", "alpha", "work");
    const order: string[] = [];
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    vi.spyOn(logger, "error").mockImplementation(() => {
      throw new Error("logger boom");
    });
    tree.onChange(() => {
      order.push("g1");
      const err = new Error("hostile");
      Object.defineProperty(err, "message", {
        get() {
          JSON.stringify(cyclic);
          return cyclic as unknown as string;
        },
      });
      throw err;
    });
    tree.onChange(() => {
      order.push("g2");
    });
    tree.onNodeChange("mn-1", () => {
      order.push("n1");
    });
    expect(() => tree.applyActivityEvent("mn-1", { type: "thinking" })).not.toThrow();
    expect(order).toEqual(["g1", "g2", "n1"]);
    vi.restoreAllMocks();
  });
});

const SESSION_TS = "2024-12-03T14:00:01.000Z";

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall", id, name, arguments: args };
}

function assistantRecord(
  id: string,
  parentId: string | null,
  content: unknown[],
  stopReason: "stop" | "toolUse" = "toolUse",
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: SESSION_TS,
    message: {
      role: "assistant",
      content,
      api: "anthropic",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: NOW,
    },
  };
}

function toolResultRecord(
  id: string,
  parentId: string,
  toolCallId: string,
  toolName: string,
  opts: { isError?: boolean; details?: unknown; text?: string } = {},
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: SESSION_TS,
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: opts.text ?? "ok" }],
      isError: opts.isError ?? false,
      timestamp: NOW,
      details: opts.details,
    },
  };
}

describe("transcript rehydration", () => {
  it("reconstructs parent notifications as ordinary completed tool activity", () => {
    const events = [
      assistantRecord("a1", null, [toolCall("call_read", "read", { path: "src/auth.ts" })]),
      toolResultRecord("r1", "a1", "call_read", "read", { text: "export function auth() {}" }),
      assistantRecord("a2", "r1", [
        toolCall("call_send", "send_minion_peer", { to: "parent", body: "status update" }),
      ]),
      toolResultRecord("r2", "a2", "call_send", "send_minion_peer", {
        details: { status: "queued", to: "parent", from: "child-1", parentTurnTriggered: false },
      }),
    ];
    const flattened = sessionRecordsToActivityEvents(events);
    expect(flattened.map((event) => event.type)).toEqual([
      "turn_end",
      "tool_start",
      "tool_end",
      "turn_end",
      "tool_start",
      "tool_end",
    ]);
    const replayed = replayActivity(flattened, NOW);
    expect(replayed.current?.phase).toBe("thinking");
    expect(replayed.current?.turn).toBe(2);
    expect(summaries(replayed.history)).toContain("→ read src/auth.ts");
  });

  it("does not synthesize a parked state from parent-bound tool records", () => {
    const completed = sessionRecordsToActivityEvents([
      assistantRecord("a1", null, [
        toolCall("call_send", "send_minion_peer", { to: "parent", body: "status update" }),
      ]),
      toolResultRecord("r1", "a1", "call_send", "send_minion_peer", {
        details: { status: "queued", to: "parent" },
      }),
    ]);
    expect(completed.map((event) => event.type)).toEqual(["turn_end", "tool_start", "tool_end"]);
    expect(replayActivity(completed, NOW).current?.phase).toBe("thinking");
  });

  it("does not wait on unmatched or malformed calls and never cross-pairs", () => {
    const unmatched = sessionRecordsToActivityEvents([
      assistantRecord("a1", null, [
        toolCall("call_send", "send_minion_peer", { to: "parent", body: "need a ruling" }),
      ]),
      toolResultRecord("r1", "a1", "call_other", "send_minion_peer", {
        details: { status: "queued", to: "parent" },
      }),
    ]);
    expect(unmatched.some((event) => event.type === "waiting")).toBe(false);
    expect(replayActivity(unmatched, NOW).current?.phase).toBe("tool");

    const malformedCall = sessionRecordsToActivityEvents([
      assistantRecord("a1", null, [
        { type: "toolCall", name: "send_minion_peer", arguments: { to: "parent" } },
      ]),
      toolResultRecord("r1", "a1", "call_send", "send_minion_peer", {
        details: { status: "queued", to: "parent" },
      }),
    ]);
    expect(malformedCall.some((event) => event.type === "waiting")).toBe(false);
  });

  it("skips malformed and truncated JSONL records without dropping later events", () => {
    const content = [
      JSON.stringify(
        assistantRecord("a1", null, [toolCall("call_read", "read", { path: "src/auth.ts" })]),
      ),
      "{not json",
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_trunc",',
      JSON.stringify(toolResultRecord("r1", "a1", "call_read", "read", { text: "ok" })),
      JSON.stringify(
        assistantRecord("a2", "r1", [
          toolCall("call_send", "send_minion_peer", { to: "parent", body: "need a ruling" }),
        ]),
      ),
      JSON.stringify(
        toolResultRecord("r2", "a2", "call_send", "send_minion_peer", {
          details: { status: "queued", to: "parent" },
        }),
      ),
    ].join("\n");
    const records = parseJsonlRecords(content);
    expect(records).toHaveLength(4);
    const replayed = replayActivity(sessionRecordsToActivityEvents(records), NOW);
    expect(replayed.current?.phase).toBe("thinking");
    expect(summaries(replayed.history)).toContain("→ read src/auth.ts");
  });

  it("quarantines duplicate active toolCallIds so no result can wait", () => {
    const eventKey = (event: { type: string; toolName?: string }) =>
      event.type === "tool_start" ? `tool_start:${event.toolName}` : event.type;

    const readThenSend = sessionRecordsToActivityEvents([
      assistantRecord("a1", null, [
        toolCall("dup", "read", { path: "src/auth.ts" }),
        toolCall("dup", "send_minion_peer", { to: "parent", body: "need a ruling" }),
      ]),
      toolResultRecord("r1", "a1", "dup", "read", {
        details: { status: COMM_SEND_STATUS.queued, to: "parent" },
      }),
      toolResultRecord("r2", "a1", "dup", "send_minion_peer", {
        details: { status: COMM_SEND_STATUS.queued, to: "parent" },
      }),
    ]);
    expect(readThenSend.map(eventKey)).toEqual(["turn_end", "tool_start:read"]);
    expect(readThenSend.some((event) => event.type === "waiting")).toBe(false);
    expect(replayActivity(readThenSend, NOW).current?.phase).not.toBe("waiting");

    const sendThenRead = sessionRecordsToActivityEvents([
      assistantRecord("a1", null, [
        toolCall("dup", "send_minion_peer", { to: "parent", body: "need a ruling" }),
        toolCall("dup", "read", { path: "src/auth.ts" }),
      ]),
      toolResultRecord("r1", "a1", "dup", "send_minion_peer", {
        details: { status: COMM_SEND_STATUS.queued, to: "parent" },
      }),
      toolResultRecord("r2", "a1", "dup", "read", {
        details: { status: COMM_SEND_STATUS.queued, to: "parent" },
      }),
    ]);
    expect(sendThenRead.map(eventKey)).toEqual(["turn_end", "tool_start:send_minion_peer"]);
    expect(sendThenRead.some((event) => event.type === "waiting")).toBe(false);

    const laterUnique = sessionRecordsToActivityEvents([
      assistantRecord("a1", null, [
        toolCall("dup", "read", { path: "src/auth.ts" }),
        toolCall("dup", "send_minion_peer", { to: "parent", body: "need a ruling" }),
      ]),
      toolResultRecord("r1", "a1", "dup", "read", {
        details: { status: COMM_SEND_STATUS.queued, to: "parent" },
      }),
      assistantRecord("a2", null, [
        toolCall("unique", "send_minion_peer", { to: "parent", body: "need a ruling" }),
      ]),
      toolResultRecord("r3", "a2", "unique", "send_minion_peer", {
        details: { status: COMM_SEND_STATUS.queued, to: "parent" },
      }),
    ]);
    expect(laterUnique.map(eventKey)).toEqual([
      "turn_end",
      "tool_start:read",
      "turn_end",
      "tool_start:send_minion_peer",
      "tool_end",
    ]);
    expect(replayActivity(laterUnique, NOW).current?.phase).toBe("thinking");
  });

  it("parseSessionHistory reconstructs snapshots without turn N entries", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-activity-rehydrate-"));
    const session = new FakeChildSession();
    const sessionPath = join(cwd, "child.jsonl");
    const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
      createChildRuntime: async () => ({
        runtime: {
          session,
          dispose: () => {
            session.dispose();
          },
        },
        sessionPath,
      }),
    });
    const start: CreateMinionSessionOptions = {
      id: "child-1",
      name: "alpha",
      task: "do work",
      config,
      spawnedBy: "parent",
      cwd,
      modelRegistry: {} as CreateMinionSessionOptions["modelRegistry"],
    };

    return manager.startChild(start).then(() => {
      writeFileSync(
        sessionPath,
        [
          JSON.stringify(
            assistantRecord("a1", null, [toolCall("call_read", "read", { path: "src/auth.ts" })]),
          ),
          JSON.stringify(toolResultRecord("r1", "a1", "call_read", "read", { text: "ok" })),
          JSON.stringify(
            assistantRecord("a2", "r1", [toolCall("call_bash", "bash", { command: "npm test" })]),
          ),
        ].join("\n"),
        "utf-8",
      );
      const history = manager.parseSessionHistory("child-1");
      expect(history.some((item) => /turn \d/.test(item.summary))).toBe(false);
      expect(history.some((item) => item.summary === "→ read src/auth.ts")).toBe(true);
      expect(history.at(-1)?.summary).toBe("→ $ npm test");
      expect(history.at(-1)?.turn).toBe(2);
    });
  });

  it("parseSessionHistory skips malformed records without inventing parked state", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-activity-malformed-"));
    const session = new FakeChildSession();
    const sessionPath = join(cwd, "child.jsonl");
    const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
      createChildRuntime: async () => ({
        runtime: {
          session,
          dispose: () => {
            session.dispose();
          },
        },
        sessionPath,
      }),
    });
    await manager.startChild({
      id: "child-1",
      name: "alpha",
      task: "do work",
      config,
      spawnedBy: "parent",
      cwd,
      modelRegistry: {} as CreateMinionSessionOptions["modelRegistry"],
    });
    writeFileSync(
      sessionPath,
      [
        JSON.stringify(
          assistantRecord("a1", null, [toolCall("call_read", "read", { path: "src/auth.ts" })]),
        ),
        "{not-json",
        '{"type":"message","message":{"role":"toolResult","toolCallId":"call_trunc",',
        JSON.stringify(toolResultRecord("r1", "a1", "call_read", "read", { text: "ok" })),
        JSON.stringify(
          assistantRecord("a2", "r1", [
            toolCall("call_send", "send_minion_peer", { to: "parent", body: "need a ruling" }),
          ]),
        ),
        JSON.stringify(
          toolResultRecord("r2", "a2", "call_send", "send_minion_peer", {
            details: { status: "queued", to: "parent" },
          }),
        ),
      ].join("\n"),
      "utf-8",
    );
    const history = manager.parseSessionHistory("child-1");
    expect(history.some((item) => item.summary === "→ read src/auth.ts")).toBe(true);
    expect(history.at(-1)?.phase).toBe("thinking");
    expect(history.at(-1)?.summary).toContain("send_minion_peer");
    expect(manager.parseSessionOutput("child-1")).toBe("");
  });
});

describe("spawn and orchestrated share activity; packets exclude spawn", () => {
  it("bindTreeActivity is identical for spawn and orchestrated children", () => {
    const tree = new AgentTree();
    tree.add("mn-spawn", "alpha", "foreground", { kind: "spawn" });
    tree.add("mn-orch", "bravo", "background", { kind: "orchestrated", groupId: "grp-1" });
    const spawnBound = bindTreeActivity(tree, "mn-spawn");
    const orchBound = bindTreeActivity(tree, "mn-orch");
    spawnBound.onToolActivity({ type: "start", toolName: "read", args: { path: "a.ts" } });
    orchBound.onToolActivity({ type: "start", toolName: "read", args: { path: "a.ts" } });
    expect(tree.get("mn-spawn")?.activity).toMatchObject({
      phase: "tool",
      summary: "→ read a.ts",
    });
    expect(tree.get("mn-orch")?.activity).toMatchObject({
      phase: "tool",
      summary: "→ read a.ts",
    });
    expect(tree.get("mn-spawn")?.kind).toBe("spawn");
    expect(tree.get("mn-orch")?.kind).toBe("orchestrated");
  });

  it("fleet packets include orchestrated activity and exclude spawn children", () => {
    const tree = new AgentTree();
    const sendMessage = vi.fn();
    const groups = new OrchestrationGroupState();
    const pending: Array<() => void> = [];
    groups.commitGroup({ groupId: "grp-1", cwd: "/tmp" });
    const dispatcher = createLifecyclePacketDispatcher({
      getTree: () => tree,
      getGroups: () => groups,
      sendMessage: sendMessage as ExtensionAPI["sendMessage"],
      now: () => 10_000,
      schedule: (run) => pending.push(run),
    });
    tree.add("mn-spawn", "alpha", "foreground", { kind: "spawn" });
    tree.applyActivityEvent("mn-spawn", {
      type: "tool_start",
      toolName: "read",
      args: { path: "spawn-only.ts" },
    });
    tree.add("mn-orch", "bravo", "background", {
      kind: "orchestrated",
      groupId: "grp-1",
      lifecycleId: "orch-lifecycle",
      description: "Keep going",
    });
    tree.applyActivityEvent("mn-orch", {
      type: "tool_start",
      toolName: "read",
      args: { path: "src/auth.ts" },
    });
    tree.applyActivityEvent("mn-orch", {
      type: "narrative",
      text: "untrusted packet prose should not leak",
    });
    tree.add("mn-done", "charlie", "finished", {
      kind: "orchestrated",
      groupId: "grp-1",
      lifecycleId: "done-lifecycle",
      description: "Done",
    });
    tree.updateStatus("mn-done", "completed", 0);
    const epoch = groups.acceptLiveWork("grp-1", [
      { childId: "mn-orch", lifecycleId: "orch-lifecycle" },
      { childId: "mn-done", lifecycleId: "done-lifecycle" },
    ])!;
    tree.setLifecycleEpoch("mn-orch", "orch-lifecycle", epoch);
    tree.setLifecycleEpoch("mn-done", "done-lifecycle", epoch);

    dispatcher.enqueue({
      class: "settled",
      groupId: "grp-1",
      childId: "mn-done",
      lifecycleId: "done-lifecycle",
      epoch,
      output: "ok",
    });
    dispatcher.enqueue({
      class: "settled",
      groupId: "grp-1",
      childId: "mn-spawn",
      lifecycleId: "spawn-lifecycle",
      epoch,
      output: "spawn should not wake",
    });
    while (pending.length > 0) pending.shift()?.();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const details = sendMessage.mock.calls[0]?.[0]?.details as LifecyclePacketDetails;
    expect(details.changed.map((child) => child.childId)).toEqual(["mn-done"]);
    expect(details.stillRunning.map((child) => child.childId)).toEqual(["mn-orch"]);
    expect(details.stillRunning[0]?.activity?.summary).toBe("→ read src/auth.ts");
    expect(details.stillRunning[0]?.activity?.phase).toBe("tool");
    expect(details.stillRunning[0]?.activity?.toolPreview).toBe("read src/auth.ts");
    expect(details.stillRunning[0]?.activity).not.toHaveProperty("toolName");
    expect(details.stillRunning[0]?.activity).not.toHaveProperty("narrativePreview");
    expect(JSON.stringify(details.stillRunning[0]?.activity)).not.toContain(
      "untrusted packet prose",
    );
    expect(details.stillRunning[0]?.activity).not.toBe(tree.get("mn-orch")?.activity);
    const projected = { ...details.stillRunning[0]!.activity! };
    projected.summary = "hacked";
    expect(tree.get("mn-orch")?.activity?.summary).toBe("→ read src/auth.ts");
    expect(details.stillRunning.some((child) => child.childId === "mn-spawn")).toBe(false);
    expect(JSON.stringify(details)).not.toContain("spawn-only.ts");
  });
});

describe("no turn N overwrite regression", () => {
  it("turn completion never overwrites a live tool summary", () => {
    const tree = new AgentTree();
    tree.add("mn-1", "alpha", "work");
    const bound = bindTreeActivity(tree, "mn-1");
    bound.onToolActivity({ type: "start", toolName: "read", args: { path: "src/auth.ts" } });
    bound.onTurnEnd(1);
    bound.onTurnEnd(2);
    const node = tree.get("mn-1")!;
    expect(node.lastActivity).toBe("→ read src/auth.ts");
    expect(node.activity?.turn).toBe(2);
    expect(summaries(node.activityHistory)).not.toContain("turn 1");
    expect(summaries(node.activityHistory)).not.toContain("turn 2");
  });
});

describe("manager settling callback", () => {
  it("first idle agent_end notifies settling without committing terminal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-activity-settle-"));
    const session = new FakeChildSession();
    const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
      createChildRuntime: async () => ({
        runtime: {
          session,
          dispose: () => {
            session.dispose();
          },
        },
        sessionPath: join(cwd, "child.jsonl"),
      }),
    });
    const tree = new AgentTree();
    tree.add("child-settle", "alpha", "wrap up");
    const bound = bindTreeActivity(tree, "child-settle");
    const idle = createDeferred<void>();
    session.waitForIdle = () => idle.promise;

    const handle = await manager.startChild({
      id: "child-settle",
      name: "alpha",
      task: "wrap up",
      config,
      spawnedBy: "parent",
      cwd,
      modelRegistry: {} as CreateMinionSessionOptions["modelRegistry"],
      onAgentEnd: bound.onAgentEnd,
    });
    let settled = false;
    const wait = handle.wait().then((event) => {
      settled = true;
      return event;
    });

    session.emit({ type: "agent_end", willRetry: false });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(manager.getTerminal("child-settle")).toBeUndefined();
    expect(tree.get("child-settle")?.status).toBe("running");
    expect(tree.get("child-settle")?.activity?.phase).toBe("settling");
    expect(tree.get("child-settle")?.lastActivity).toBe("settling");

    session.emit({ type: "agent_settled" });
    idle.resolve();
    await expect(wait).resolves.toMatchObject({ class: "settled" });
  });
});

describe("terminal observer exception safety", () => {
  it("onComplete throw still settles, emits, disposes, and keeps terminal authority", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-activity-settle-"));
    const session = new FakeChildSession();
    const bus = new EventBus();
    const completions: Array<{ id: string; class: string }> = [];
    bus.on(MINION_COMPLETE_CHANNEL, (event: { id: string; class: string }) => {
      completions.push(event);
    });
    const onComplete = vi.fn(() => {
      throw new Error("observer boom");
    });
    const logError = vi.spyOn(logger, "error").mockImplementation((_scope, msg) => {
      if (msg === "on-complete-error") throw new Error("log boom");
    });
    try {
      const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), bus, {
        createChildRuntime: async () => ({
          runtime: {
            session,
            dispose: () => {
              session.dispose();
            },
          },
          sessionPath: join(cwd, "child.jsonl"),
        }),
      });
      const idle = createDeferred<void>();
      session.waitForIdle = () => idle.promise;
      const handle = await manager.startChild({
        id: "child-obs",
        name: "alpha",
        task: "wrap up",
        config,
        spawnedBy: "parent",
        cwd,
        modelRegistry: {} as CreateMinionSessionOptions["modelRegistry"],
        onComplete,
      });

      session.emit({ type: "agent_settled" });
      idle.resolve();
      await expect(handle.wait()).resolves.toMatchObject({ class: "settled" });
      expect(manager.getTerminal("child-obs")?.class).toBe("settled");
      expect(completions).toEqual([expect.objectContaining({ id: "child-obs", class: "settled" })]);
      expect(onComplete).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(session.disposed).toBe(true);
        expect(manager.getSessionHandle("child-obs")).toBeUndefined();
      });
      expect(
        manager.commitTerminal("child-obs", {
          class: "failed",
          exitCode: 1,
          output: "",
          error: "nope",
        }),
      ).toBe(false);
      expect(manager.getTerminal("child-obs")?.class).toBe("settled");
      expect(logError).toHaveBeenCalled();
    } finally {
      logError.mockRestore();
    }
  });

  it("async onComplete rejection is contained without blocking terminal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-activity-settle-"));
    const session = new FakeChildSession();
    const bus = new EventBus();
    const completions: Array<{ id: string; class: string }> = [];
    bus.on(MINION_COMPLETE_CHANNEL, (event: { id: string; class: string }) => {
      completions.push(event);
    });
    const gate = createDeferred<void>();
    const onComplete = vi.fn(async () => {
      await gate.promise;
      throw new Error("async observer boom");
    });
    const logError = vi.spyOn(logger, "error");
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), bus, {
        createChildRuntime: async () => ({
          runtime: {
            session,
            dispose: () => {
              session.dispose();
            },
          },
          sessionPath: join(cwd, "child.jsonl"),
        }),
      });
      const idle = createDeferred<void>();
      session.waitForIdle = () => idle.promise;
      const handle = await manager.startChild({
        id: "child-obs-async",
        name: "alpha",
        task: "wrap up",
        config,
        spawnedBy: "parent",
        cwd,
        modelRegistry: {} as CreateMinionSessionOptions["modelRegistry"],
        onComplete,
      });

      session.emit({ type: "agent_settled" });
      idle.resolve();
      await expect(handle.wait()).resolves.toMatchObject({ class: "settled" });
      expect(manager.getTerminal("child-obs-async")?.class).toBe("settled");
      expect(completions).toEqual([
        expect.objectContaining({ id: "child-obs-async", class: "settled" }),
      ]);
      expect(onComplete).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(session.disposed).toBe(true);
        expect(manager.getSessionHandle("child-obs-async")).toBeUndefined();
      });
      expect(manager.getSession("child-obs-async")).toBeUndefined();
      expect(logError.mock.calls.filter((call) => call[1] === "on-complete-error")).toHaveLength(0);

      gate.resolve();
      await vi.waitFor(() => {
        expect(logError.mock.calls.filter((call) => call[1] === "on-complete-error")).toHaveLength(
          1,
        );
      });
      expect(logError).toHaveBeenCalledWith(
        "subsession",
        "on-complete-error",
        expect.objectContaining({ childId: "child-obs-async", error: "async observer boom" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([]);
      expect(manager.getTerminal("child-obs-async")?.class).toBe("settled");
      expect(
        manager.commitTerminal("child-obs-async", {
          class: "failed",
          exitCode: 1,
          output: "",
          error: "nope",
        }),
      ).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      logError.mockRestore();
    }
  });
});

describe("nonblocking child-to-parent notification", () => {
  it("settles normally without a parent reply and never enters a parked activity phase", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-notify-settle-"));
    const session = new FakeChildSession();
    const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
      createChildRuntime: async () => ({
        runtime: { session, dispose: () => session.dispose() },
        sessionPath: join(cwd, "child.jsonl"),
      }),
    });
    const tree = new AgentTree();
    tree.add("child-notify", "alpha", "send status", {
      kind: "orchestrated",
      groupId: "grp-1",
      lifecycleId: "life-notify",
      lifecycleEpoch: 1,
    });
    const groups = new OrchestrationGroupState();
    groups.commitGroup({ groupId: "grp-1", cwd });
    groups.acceptLiveWork("grp-1", [{ childId: "child-notify", lifecycleId: "life-notify" }]);
    const handle = await manager.startChild({
      id: "child-notify",
      name: "alpha",
      task: "send status",
      config,
      spawnedBy: "parent",
      cwd,
      modelRegistry: {} as CreateMinionSessionOptions["modelRegistry"],
    });
    const mailbox = new MinionCommMailbox({
      getTree: () => tree,
      getGroups: () => groups,
      isLive: (id) => manager.isLive(id),
      followUp: async (id, text) => {
        const live = manager.getSessionHandle(id);
        if (!live) throw new Error(`Child ${id} is terminal; further mail is rejected`);
        await live.followUp(text);
      },
    });

    const sent = mailbox.send({
      from: "child-notify",
      lifecycleId: "life-notify",
      lifecycleEpoch: 1,
      to: PARENT_RECIPIENT_ID,
      groupId: "grp-1",
      body: "implementation complete",
    });
    expect(sent.status).toBe(COMM_SEND_STATUS.queued);
    expect(tree.get("child-notify")?.activity?.phase).toBe("starting");

    session.emit({ type: "agent_settled" });
    await expect(handle.wait()).resolves.toMatchObject({ class: "settled" });
    expect(manager.isLive("child-notify")).toBe(false);
    expect(mailbox.peekPending(PARENT_RECIPIENT_ID).map((message) => message.body)).toEqual([
      "implementation complete",
    ]);
  });
});
