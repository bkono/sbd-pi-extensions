import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_HISTORY_CAP,
  activityEventsFromSessionRecord,
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
  PARENT_RECIPIENT_ID,
} from "../orchestration/index.js";
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

function userStart(text: string): ChildSessionEvent {
  return {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

const config: AgentConfig = {
  name: "worker",
  description: "test",
  systemPrompt: "do the work",
  source: "builtin",
  filePath: "builtin:worker",
};

describe("activity reducer phases", () => {
  it("transitions starting → thinking → tool → thinking → waiting → resume → settling", () => {
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
    expect(apply({ type: "waiting" })).toMatchObject({
      phase: "waiting",
      summary: "waiting on parent",
    });
    expect(apply({ type: "settling" }).phase).toBe("waiting");
    expect(apply({ type: "thinking" }).phase).toBe("waiting");
    expect(apply({ type: "tool_start", toolName: "read", args: { path: "x.ts" } }).phase).toBe(
      "waiting",
    );
    expect(apply({ type: "tool_end" }).phase).toBe("waiting");
    expect(apply({ type: "turn_end", turn: 4 }).phase).toBe("waiting");
    expect(apply({ type: "narrative", text: "tail" }).phase).toBe("waiting");
    expect(apply({ type: "resume" })).toMatchObject({ phase: "thinking", summary: "thinking" });
    expect(apply({ type: "settling" }).phase).toBe("settling");
  });

  it("keeps waiting through thinking, tool, turn, narrative, and settling", () => {
    let snap = reduceActivity(undefined, { type: "waiting" }, NOW).snapshot;
    for (const event of [
      { type: "thinking" as const },
      { type: "tool_start" as const, toolName: "bash", args: { command: "ls" } },
      { type: "tool_end" as const },
      { type: "turn_end" as const, turn: 2 },
      { type: "narrative" as const, text: "still waiting" },
      { type: "settling" as const },
    ]) {
      snap = reduceActivity(snap, event, NOW).snapshot;
      expect(snap.phase).toBe("waiting");
    }
    snap = reduceActivity(snap, { type: "resume" }, NOW).snapshot;
    expect(snap.phase).toBe("thinking");
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

  it("tool_end does not clobber waiting", () => {
    const waiting = reduceActivity(undefined, { type: "waiting" }, NOW).snapshot;
    const next = reduceActivity(waiting, { type: "tool_end" }, NOW + 1).snapshot;
    expect(next.phase).toBe("waiting");
    expect(next.summary).toBe("waiting on parent");
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

  it("waiting stays running and is explicit", () => {
    const tree = new AgentTree();
    tree.add("mn-1", "alpha", "ask parent", { kind: "orchestrated", groupId: "grp-1" });
    tree.applyActivityEvent("mn-1", { type: "waiting" });
    const node = tree.get("mn-1")!;
    expect(node.status).toBe("running");
    expect(node.activity?.phase).toBe("waiting");
    expect(node.lastActivity).toBe("waiting on parent");
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
  it("reconstructs equivalent activity from persisted SessionManager records", () => {
    const events = [
      assistantRecord("a1", null, [toolCall("call_read", "read", { path: "src/auth.ts" })]),
      toolResultRecord("r1", "a1", "call_read", "read", {
        text: "export function auth() {}",
      }),
      assistantRecord("a2", "r1", [
        toolCall("call_send", "send_minion_peer", { to: "parent", body: "need a ruling" }),
      ]),
      toolResultRecord("r2", "a2", "call_send", "send_minion_peer", {
        details: {
          status: "queued",
          to: "parent",
          from: "child-1",
          parentTurnTriggered: false,
        },
      }),
    ];
    const flattened = sessionRecordsToActivityEvents(events);
    const replayed = replayActivity(flattened, NOW);
    expect(replayed.current?.phase).toBe("waiting");
    expect(replayed.current?.summary).toBe("waiting on parent");
    expect(replayed.current?.turn).toBe(2);
    expect(summaries(replayed.history)).toContain("→ read src/auth.ts");
    expect(summaries(replayed.history).some((line) => /turn \d/.test(line))).toBe(false);
  });

  it("does not treat a mere parent-bound tool start as waiting", () => {
    const startOnly = sessionRecordsToActivityEvents([
      assistantRecord("a1", null, [
        toolCall("call_send", "send_minion_peer", { to: "parent", body: "need a ruling" }),
      ]),
    ]);
    expect(startOnly.some((event) => event.type === "waiting")).toBe(false);
    expect(replayActivity(startOnly, NOW).current?.phase).toBe("tool");
    expect(
      activityEventsFromSessionRecord(
        assistantRecord("a1", null, [toolCall("call_send", "send_minion_peer", { to: "parent" })]),
      ).some((event) => event.type === "waiting"),
    ).toBe(false);

    const failed = sessionRecordsToActivityEvents([
      assistantRecord("a1", null, [
        toolCall("call_send", "send_minion_peer", { to: "parent", body: "need a ruling" }),
      ]),
      toolResultRecord("r1", "a1", "call_send", "send_minion_peer", {
        details: { status: "mailbox-full", to: "parent" },
      }),
    ]);
    expect(failed.some((event) => event.type === "waiting")).toBe(false);
    expect(replayActivity(failed, NOW).current?.phase).toBe("thinking");
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
    expect(replayed.current?.phase).toBe("waiting");
    expect(summaries(replayed.history)).toContain("→ read src/auth.ts");
  });

  it("quarantines duplicate active toolCallIds so no result can wait", () => {
    const content = [
      JSON.stringify(
        assistantRecord("a1", null, [
          toolCall("dup", "read", { path: "src/auth.ts" }),
          toolCall("dup", "send_minion_peer", {
            to: "parent",
            body: "need a ruling",
          }),
        ]),
      ),
      JSON.stringify(
        toolResultRecord("t1", "a1", "dup", "send_minion_peer", {
          isError: false,
          details: { status: "queued", to: "parent" },
        }),
      ),
    ].join("\n");
    const replayed = replayActivity(
      sessionRecordsToActivityEvents(parseJsonlRecords(content)),
      NOW,
    );
    expect(replayed.current?.phase).not.toBe("waiting");
    expect(summaries(replayed.history)).not.toContain("waiting on parent");
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

  it("parseSessionHistory skips malformed records and reconstructs accepted waiting", async () => {
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
    expect(history.at(-1)?.phase).toBe("waiting");
    expect(history.at(-1)?.summary).toBe("waiting on parent");
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
    const pending: Array<() => void> = [];
    const dispatcher = createLifecyclePacketDispatcher({
      getTree: () => tree,
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
      description: "Done",
    });
    tree.updateStatus("mn-done", "completed", 0);

    dispatcher.enqueue({
      class: "settled",
      groupId: "grp-1",
      childId: "mn-done",
      output: "ok",
    });
    dispatcher.enqueue({
      class: "settled",
      groupId: "grp-1",
      childId: "mn-spawn",
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

describe("waiting mailbox resume", () => {
  async function setupWaitingChild(opts?: { streaming?: boolean }) {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-activity-wait-"));
    const session = new FakeChildSession();
    if (opts?.streaming) session.isStreaming = true;
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
    tree.add("child-wait", "alpha", "ask parent", {
      kind: "orchestrated",
      groupId: "grp-1",
    });
    const bound = bindTreeActivity(tree, "child-wait");
    const idle = createDeferred<void>();
    session.waitForIdle = () => idle.promise;

    const handle = await manager.startChild({
      id: "child-wait",
      name: "alpha",
      task: "ask parent",
      config,
      spawnedBy: "parent",
      cwd,
      modelRegistry: {} as CreateMinionSessionOptions["modelRegistry"],
      onToolActivity: bound.onToolActivity,
      onTextDelta: bound.onTextDelta,
      onTurnEnd: bound.onTurnEnd,
      onAgentEnd: bound.onAgentEnd,
      onWaitingResume: bound.onWaitingResume,
    });
    if (opts?.streaming) session.isStreaming = true;
    const mailbox = new MinionCommMailbox({
      getTree: () => tree,
      getGroups: () => ({ getOpenGroup: () => ({ groupId: "grp-1", cwd }) }),
      isLive: (id) => manager.isLive(id),
      followUp: async (id, text, followOpts) => {
        const live = manager.getSessionHandle(id);
        if (!live) throw new Error(`Child ${id} is terminal; further mail is rejected`);
        await live.followUp(text, followOpts);
      },
      markWaitingOnParent: (id) => manager.markWaitingOnParent(id),
    });
    const asked = mailbox.send({
      from: "child-wait",
      to: PARENT_RECIPIENT_ID,
      groupId: "grp-1",
      body: "need a ruling",
    });
    expect(asked.status).toBe(COMM_SEND_STATUS.queued);
    expect(tree.get("child-wait")?.activity?.phase).toBe("waiting");
    return { session, manager, tree, idle, handle, mailbox };
  }

  it("no-reply tail text/tool/end/settled remains running and waiting", async () => {
    const { session, manager, tree } = await setupWaitingChild();
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "still asking" },
    });
    session.emit({
      type: "tool_execution_start",
      toolName: "read",
      args: { path: "src/auth.ts" },
    });
    session.emit({ type: "tool_execution_end", toolName: "read" });
    session.emit({ type: "agent_end", willRetry: false });
    session.emit({ type: "agent_settled" });
    await Promise.resolve();
    expect(manager.isLive("child-wait")).toBe(true);
    expect(manager.getTerminal("child-wait")).toBeUndefined();
    expect(tree.get("child-wait")?.status).toBe("running");
    expect(tree.get("child-wait")?.activity?.phase).toBe("waiting");
  });

  it("idle reply acceptance stays waiting, starts prompt, matching user start resumes then settles", async () => {
    const { session, manager, tree, idle, handle, mailbox } = await setupWaitingChild();
    session.emit({ type: "agent_end", willRetry: false });
    session.emit({ type: "agent_settled" });
    await Promise.resolve();
    expect(manager.isLive("child-wait")).toBe(true);
    expect(tree.get("child-wait")?.activity?.phase).toBe("waiting");

    const initialPrompts = session.prompts.length;
    const reply = mailbox.send({
      from: PARENT_RECIPIENT_ID,
      to: "child-wait",
      groupId: "grp-1",
      body: "continue",
    });
    expect(reply.status).toBe(COMM_SEND_STATUS.queued);
    expect(tree.get("child-wait")?.activity?.phase).toBe("waiting");
    await vi.waitFor(() => {
      expect(session.prompts.length).toBe(initialPrompts + 1);
    });
    expect(session.followUps).toEqual([]);
    const delivered = session.prompts.at(-1);
    expect(delivered).toBeTruthy();

    session.emit(userStart(delivered ?? ""));
    await Promise.resolve();
    expect(tree.get("child-wait")?.activity?.phase).toBe("thinking");
    expect(session.prompts.length).toBe(initialPrompts + 1);

    session.emit({ type: "agent_end", willRetry: false });
    await Promise.resolve();
    expect(tree.get("child-wait")?.activity?.phase).toBe("settling");
    expect(tree.get("child-wait")?.status).toBe("running");

    session.emit({ type: "agent_settled" });
    idle.resolve();
    await expect(handle.wait()).resolves.toMatchObject({ class: "settled" });
    expect(manager.getTerminal("child-wait")?.class).toBe("settled");
  });

  it("active-run followUp remains waiting until matching user message_start", async () => {
    const { session, tree, mailbox } = await setupWaitingChild({ streaming: true });
    const reply = mailbox.send({
      from: PARENT_RECIPIENT_ID,
      to: "child-wait",
      groupId: "grp-1",
      body: "continue",
    });
    expect(reply.status).toBe(COMM_SEND_STATUS.queued);
    await vi.waitFor(() => {
      expect(session.followUps.length).toBe(1);
    });
    expect(tree.get("child-wait")?.activity?.phase).toBe("waiting");
    const delivered = session.followUps[0] ?? "";
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "tail" },
    });
    expect(tree.get("child-wait")?.activity?.phase).toBe("waiting");
    session.emit(userStart(delivered));
    await Promise.resolve();
    expect(tree.get("child-wait")?.activity?.phase).toBe("thinking");
  });

  it("delivery throw stays waiting and retryable", async () => {
    const { session, manager, tree, mailbox } = await setupWaitingChild();
    session.prompt = async (text: string) => {
      session.prompts.push(text);
      throw new Error("queue boom");
    };
    const reply = mailbox.send({
      from: PARENT_RECIPIENT_ID,
      to: "child-wait",
      groupId: "grp-1",
      body: "continue",
    });
    expect(reply.status).toBe(COMM_SEND_STATUS.queued);
    await vi.waitFor(() => {
      expect(session.prompts.length).toBeGreaterThan(1);
    });
    expect(manager.isLive("child-wait")).toBe(true);
    expect(tree.get("child-wait")?.status).toBe("running");
    expect(tree.get("child-wait")?.activity?.phase).toBe("waiting");
  });

  it("abort while waiting wins exactly once", async () => {
    const { manager, handle } = await setupWaitingChild();
    handle.abort();
    await expect(handle.wait()).resolves.toMatchObject({ class: "aborted" });
    expect(manager.getTerminal("child-wait")?.class).toBe("aborted");
    expect(manager.isLive("child-wait")).toBe(false);
  });

  it("provider failure while waiting wins exactly once", async () => {
    const { session, manager, handle } = await setupWaitingChild();
    session.emit({
      type: "auto_retry_end",
      success: false,
      finalError: "provider down",
    });
    session.emit({ type: "agent_settled" });
    await expect(handle.wait()).resolves.toMatchObject({ class: "failed" });
    expect(manager.getTerminal("child-wait")?.class).toBe("failed");
    expect(manager.isLive("child-wait")).toBe(false);
  });

  it("stale user messages do not clear a newer wait", async () => {
    const { session, tree, mailbox } = await setupWaitingChild();
    const firstReply = mailbox.send({
      from: PARENT_RECIPIENT_ID,
      to: "child-wait",
      groupId: "grp-1",
      body: "first",
    });
    expect(firstReply.status).toBe(COMM_SEND_STATUS.queued);
    await vi.waitFor(() => {
      expect(session.prompts.length).toBeGreaterThan(1);
    });
    const stale = session.prompts.at(-1) ?? "";
    const askedAgain = mailbox.send({
      from: "child-wait",
      to: PARENT_RECIPIENT_ID,
      groupId: "grp-1",
      body: "still need a ruling",
    });
    expect(askedAgain.status).toBe(COMM_SEND_STATUS.queued);
    expect(tree.get("child-wait")?.activity?.phase).toBe("waiting");
    session.emit(userStart(stale));
    await Promise.resolve();
    expect(tree.get("child-wait")?.activity?.phase).toBe("waiting");
    const secondReply = mailbox.send({
      from: PARENT_RECIPIENT_ID,
      to: "child-wait",
      groupId: "grp-1",
      body: "second",
    });
    expect(secondReply.status).toBe(COMM_SEND_STATUS.queued);
    await vi.waitFor(() => {
      expect(session.prompts.at(-1)).not.toBe(stale);
    });
    session.emit(userStart(session.prompts.at(-1) ?? ""));
    await Promise.resolve();
    expect(tree.get("child-wait")?.activity?.phase).toBe("thinking");
  });
});
