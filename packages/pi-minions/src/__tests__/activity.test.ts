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
  reduceActivity,
  replayActivity,
  sanitizeActivityText,
} from "../activity.js";
import {
  createLifecyclePacketDispatcher,
  type LifecyclePacketDetails,
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
  async prompt(): Promise<void> {}
  abort(): void {}
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
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
  it("transitions starting → thinking → tool → thinking → waiting → settling", () => {
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
  });

  it("uses formatToolCall-quality previews for bash and read", () => {
    expect(formatToolActivity("read", { path: "src/tree.ts" }).summary).toBe("→ read src/tree.ts");
    expect(formatToolActivity("bash", { command: "npm test" }).summary).toBe("→ $ npm test");
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

    tree.updateStatus("mn-pending", "running");
    expect(tree.get("mn-pending")?.status).toBe("running");
    expect(tree.get("mn-pending")?.activity?.phase).toBe("thinking");
    expect(tree.get("mn-pending")?.lastActivity).toBe("thinking");
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
});

describe("transcript rehydration", () => {
  it("reconstructs equivalent activity from session events", () => {
    const events = [
      { type: "tool_execution_start", toolName: "read", args: { path: "src/auth.ts" } },
      { type: "tool_execution_end" },
      { type: "turn_end" },
      { type: "tool_execution_start", toolName: "send_minion_peer", args: { to: "parent" } },
      { type: "agent_end", willRetry: false },
    ];
    const flattened = events.flatMap((event) => {
      if (event.type === "turn_end") return [{ type: "turn_end" as const, turn: 1 }];
      return activityEventsFromSessionRecord(event);
    });
    const replayed = replayActivity(flattened, NOW);
    expect(replayed.current?.phase).toBe("waiting");
    expect(replayed.current?.summary).toBe("waiting on parent");
    expect(replayed.current?.turn).toBe(1);
    expect(summaries(replayed.history)).toContain("→ read src/auth.ts");
    expect(summaries(replayed.history).some((line) => /turn \d/.test(line))).toBe(false);
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
          JSON.stringify({
            type: "tool_execution_start",
            toolName: "read",
            args: { path: "src/auth.ts" },
          }),
          JSON.stringify({ type: "tool_execution_end" }),
          JSON.stringify({ type: "turn_end" }),
          JSON.stringify({ type: "turn_end" }),
          JSON.stringify({
            type: "tool_execution_start",
            toolName: "bash",
            args: { command: "npm test" },
          }),
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
