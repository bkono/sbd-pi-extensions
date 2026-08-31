import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { SEND_MINION_MESSAGE_TOOL } from "../orchestration/comm.js";
import { SubsessionManager } from "../subsessions/manager.js";
import { getMinionsDir } from "../subsessions/paths.js";
import type {
  ChildSession,
  ChildSessionEvent,
  CreateMinionSessionOptions,
} from "../subsessions/types.js";
import { AgentTree, rehydratePersistedMinion } from "../tree.js";
import type { AgentConfig, ThinkingLevel } from "../types.js";

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
  tools = new Map<string, { name: string }>();
  active = new Set<string>();
  listeners = new Set<(event: ChildSessionEvent) => void>();
  disposed = false;
  aborted = false;
  isStreaming = false;
  abortedBash = false;
  disposeCount = 0;
  callOrder: string[] = [];
  promptDeferred = createDeferred<void>();
  idleDeferred = createDeferred<void>();
  followUps: string[] = [];
  followUpHold?: ReturnType<typeof createDeferred<void>>;
  pendingFollowUps = 0;
  state = { messages: [] as unknown[] };
  thinkingLevel?: ThinkingLevel;
  thinkingLevelAtPrompt?: ThinkingLevel;

  constructor(
    toolNames: string[] = [
      "read",
      "bash",
      "beadwork_show",
      "beadwork_list_issues",
      "beadwork_issue_history",
      "beadwork_ready",
      "beadwork_blocked",
      "beadwork_status",
      "beadwork_prime",
      "beadwork_close_issue",
      "beadwork_comment_issue",
      "beadwork_create_issue",
    ],
  ) {
    for (const name of toolNames) this.tools.set(name, { name });
    this.active = new Set(toolNames);
  }

  async bindExtensions(): Promise<void> {}

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
  }

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

  registerTool(name: string): void {
    this.tools.set(name, { name });
    this.active.add(name);
  }

  prompt(_text: string): Promise<void> {
    this.thinkingLevelAtPrompt = this.thinkingLevel;
    this.isStreaming = true;
    return this.promptDeferred.promise.finally(() => {
      this.isStreaming = false;
    });
  }

  resolveIdle(): void {
    this.idleDeferred.resolve();
  }

  resolvePrompt(): void {
    this.idleDeferred.resolve();
    this.promptDeferred.resolve();
  }

  rejectPrompt(error: Error): void {
    this.idleDeferred.resolve();
    this.promptDeferred.reject(error);
  }

  abort(): void {
    this.callOrder.push("abort");
    if (this.disposed) return;
    this.aborted = true;
    this.followUpHold?.resolve();
    this.idleDeferred.resolve();
    this.promptDeferred.resolve();
  }

  abortBash(): void {
    this.callOrder.push("abortBash");
    this.abortedBash = true;
  }

  async steer(_text: string): Promise<void> {}

  holdFollowUp(): void {
    this.followUpHold = createDeferred();
  }

  releaseFollowUp(): void {
    this.followUpHold?.resolve();
  }

  async followUp(text: string): Promise<void> {
    if (this.disposed || this.aborted) {
      throw new Error("Child is terminal; further mail is rejected");
    }
    this.followUps.push(text);
    this.pendingFollowUps++;
    try {
      if (this.followUpHold) await this.followUpHold.promise;
    } finally {
      this.pendingFollowUps--;
    }
  }

  waitForIdle(): Promise<void> {
    return (async () => {
      await this.idleDeferred.promise;
      while (this.pendingFollowUps > 0 && this.followUpHold) {
        await this.followUpHold.promise;
      }
    })();
  }

  dispose(): void {
    this.callOrder.push("dispose");
    this.disposeCount++;
    this.disposed = true;
    this.followUpHold?.resolve();
    this.idleDeferred.resolve();
  }

  getSessionStats() {
    return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
  }
}

/** prompt()/waitForIdle() resolve before queued turn_end / agent_settled. */
class TrailingEventSession extends FakeChildSession {
  trailingEvents: ChildSessionEvent[] = [];

  queueTrailing(event: ChildSessionEvent): void {
    this.trailingEvents.push(event);
  }

  waitForIdle(): Promise<void> {
    return super.waitForIdle().then(() => {
      const trailing = this.trailingEvents.splice(0);
      if (trailing.length === 0) return;
      // Two microtasks so emit lands after the waitForIdle continuation that
      // used to tryCommitIdle immediately — the race this helper exists to catch.
      queueMicrotask(() => {
        queueMicrotask(() => {
          for (const event of trailing) this.emit(event);
        });
      });
    });
  }
}

const agentConfig: AgentConfig = {
  name: "ephemeral",
  description: "test minion",
  systemPrompt: "You are a test minion.",
  source: "ephemeral",
  filePath: "",
};

function createManager(session: FakeChildSession, cwd: string) {
  return new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
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
}

function startOptions(id: string, cwd: string): CreateMinionSessionOptions {
  return {
    id,
    name: "minion",
    task: "do the work",
    config: agentConfig,
    spawnedBy: "test",
    cwd,
    modelRegistry: {} as ModelRegistry,
    parentToolNames: ["read", "bash", "spawn", "halt"],
    toolSyncEnabled: false,
  };
}

describe("SubsessionManager start/wait lifecycle", () => {
  const logs: Array<{ msg: string; data: unknown }> = [];

  afterEach(() => {
    logs.length = 0;
    vi.restoreAllMocks();
  });

  function spyLogger() {
    vi.spyOn(logger, "info").mockImplementation((scope, msg, data) => {
      if (scope === "subsession") logs.push({ msg, data });
    });
  }

  it("returns from startChild before prompt resolves", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-manager-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);

    const handle = await manager.startChild(startOptions("child-1", cwd));

    expect(handle.id).toBe("child-1");
    expect(manager.getSessionHandle("child-1")).toBe(handle);
    expect(manager.getTerminal("child-1")).toBeUndefined();
    expect(session.disposed).toBe(false);
  });

  it("applies agent thinking metadata before the child prompt starts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-manager-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    const options = startOptions("child-thinking", cwd);
    options.config = { ...options.config, thinking: "medium" };

    await manager.startChild(options);

    expect(session.thinkingLevelAtPrompt).toBe("medium");
  });

  it("writes terminal metadata next to the child's session path, not the parent cwd", async () => {
    const parentCwd = mkdtempSync(join(tmpdir(), "pi-minions-parent-"));
    const groupCwd = mkdtempSync(join(tmpdir(), "pi-minions-group-"));
    const session = new FakeChildSession();
    const sessionPath = join(groupCwd, "child.jsonl");
    const manager = new SubsessionManager(parentCwd, join(parentCwd, "parent.jsonl"), undefined, {
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
    const handle = await manager.startChild(startOptions("child-cwd", groupCwd));

    expect(manager.getSessionPath("child-cwd")).toBe(sessionPath);
    expect(manager.getMinionIdFromPath(sessionPath)).toBe("child-cwd");

    session.emit({ type: "agent_settled" });
    await handle.wait();

    const metaPath = `${sessionPath}.minion-meta.json`;
    expect(existsSync(metaPath)).toBe(true);
    const metadata = JSON.parse(readFileSync(metaPath, "utf-8")) as { status?: string };
    expect(metadata.status).toBe("completed");
    expect(existsSync(join(parentCwd, "child.jsonl.minion-meta.json"))).toBe(false);
  });

  it("preserves alternate-cwd minions across manager rehydration", async () => {
    const parentCwd = mkdtempSync(join(tmpdir(), "pi-minions-parent-rehydrate-"));
    const groupCwd = mkdtempSync(join(tmpdir(), "pi-minions-group-rehydrate-"));
    const parentSessionPath = join(parentCwd, "parent.jsonl");
    const session = new FakeChildSession();
    const sessionPath = join(groupCwd, "child.jsonl");
    const live = new SubsessionManager(parentCwd, parentSessionPath, undefined, {
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

    await live.startChild(startOptions("child-remote", groupCwd));

    const linkPath = join(getMinionsDir(parentCwd), "child-remote.minion-link.json");
    expect(existsSync(linkPath)).toBe(true);
    expect(JSON.parse(readFileSync(linkPath, "utf-8"))).toEqual({ sessionPath });

    const rehydrated = new SubsessionManager(parentCwd, parentSessionPath);
    const listed = rehydrated.list();
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "child-remote",
          status: "running",
          parentSession: parentSessionPath,
        }),
      ]),
    );
    expect(rehydrated.getSessionPath("child-remote")).toBe(sessionPath);
    expect(rehydrated.getMinionIdFromPath(sessionPath)).toBe("child-remote");

    const tree = new AgentTree();
    const child = listed.find((entry) => entry.sessionId === "child-remote");
    expect(child).toBeDefined();
    rehydratePersistedMinion(tree, child!, (id, status, exitCode, error) => {
      rehydrated.updateStatus(id, status, exitCode, error);
    });

    expect(tree.get("child-remote")?.status).toBe("aborted");
    const metadata = JSON.parse(readFileSync(`${sessionPath}.minion-meta.json`, "utf-8")) as {
      status?: string;
    };
    expect(metadata.status).toBe("aborted");
    expect(existsSync(join(parentCwd, "child.jsonl.minion-meta.json"))).toBe(false);
    expect(JSON.parse(readFileSync(linkPath, "utf-8"))).toEqual({ sessionPath });
  });

  it("persists orchestrated fields and rehydrates them via list()", async () => {
    const parentCwd = mkdtempSync(join(tmpdir(), "pi-minions-orch-meta-"));
    const groupCwd = mkdtempSync(join(tmpdir(), "pi-minions-orch-group-"));
    const parentSessionPath = join(parentCwd, "parent.jsonl");
    const session = new FakeChildSession();
    const sessionPath = join(groupCwd, "child.jsonl");
    const live = new SubsessionManager(parentCwd, parentSessionPath, undefined, {
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

    const options = startOptions("child-orch", groupCwd);
    await live.startChild({
      ...options,
      config: { ...options.config, name: "reviewer" },
      kind: "orchestrated",
      groupId: "grp-1",
      taskType: "reviewImplementation",
      description: "Review registry",
      domain: { source: "adapter-x", workItemId: "ABC-123" },
    });

    const written = JSON.parse(readFileSync(`${sessionPath}.minion-meta.json`, "utf-8")) as {
      kind?: string;
      groupId?: string;
      agent?: string;
      role?: string;
      taskType?: string;
      description?: string;
      domain?: { source: string; workItemId?: string };
    };
    expect(written).toEqual(
      expect.objectContaining({
        sessionId: "child-orch",
        kind: "orchestrated",
        groupId: "grp-1",
        agent: "reviewer",
        taskType: "reviewImplementation",
        description: "Review registry",
        domain: { source: "adapter-x", workItemId: "ABC-123" },
      }),
    );
    expect(written).not.toHaveProperty("role");

    const rehydrated = new SubsessionManager(parentCwd, parentSessionPath);
    expect(rehydrated.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "child-orch",
          kind: "orchestrated",
          groupId: "grp-1",
          agent: "reviewer",
          taskType: "reviewImplementation",
          description: "Review registry",
          domain: { source: "adapter-x", workItemId: "ABC-123" },
        }),
      ]),
    );
  });

  it("parses last assistant text from a persisted session jsonl", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-session-output-"));
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

    await manager.startChild(startOptions("child-output", cwd));
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "do the work" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "first draft" },
        }),
        JSON.stringify({
          type: "tool_execution_start",
          toolName: "read",
          args: { path: "src/tree.ts" },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "persisted transcript" }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    expect(manager.parseSessionOutput("child-output")).toBe("persisted transcript");
    expect(manager.parseSessionOutput("missing")).toBe("");
  });

  it("does not emit terminal on agent_end until fully idle", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-manager-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-2", cwd));

    let settled = false;
    const wait = handle.wait().then((event) => {
      settled = true;
      return event;
    });

    session.emit({ type: "agent_end", willRetry: true });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(manager.getTerminal("child-2")).toBeUndefined();

    session.emit({ type: "agent_end", willRetry: false });
    await Promise.resolve();
    expect(settled).toBe(false);

    session.emit({ type: "agent_settled" });
    const terminal = await wait;
    expect(terminal.class).toBe("settled");
    expect(manager.getTerminal("child-2")?.class).toBe("settled");
    expect(manager.getSessionHandle("child-2")).toBeUndefined();
    expect(session.disposed).toBe(true);

    const agentEndLogs = logs.filter(
      (entry) =>
        entry.msg === "lifecycle" &&
        (entry.data as { eventClass?: string }).eventClass === "agent_end",
    );
    expect(agentEndLogs.length).toBeGreaterThan(0);
    expect(
      agentEndLogs.every(
        (entry) => (entry.data as { terminalLatchFired: boolean }).terminalLatchFired === false,
      ),
    ).toBe(true);
    expect(logs).toContainEqual({
      msg: "lifecycle",
      data: expect.objectContaining({
        childId: "child-2",
        eventClass: "settled",
        terminalLatchFired: true,
      }),
    });
  });

  it("maps halt to aborted, not failed", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-manager-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-3", cwd));

    handle.abort();
    const terminal = await handle.wait();

    expect(terminal.class).toBe("aborted");
    expect(terminal.class).not.toBe("failed");
    expect(session.aborted).toBe(true);
    expect(session.abortedBash).toBe(true);
    expect(session.disposed).toBe(true);
    const abortIdx = session.callOrder.indexOf("abort");
    const disposeIdx = session.callOrder.indexOf("dispose");
    expect(abortIdx).toBeGreaterThanOrEqual(0);
    expect(disposeIdx).toBeGreaterThan(abortIdx);
    expect(session.disposeCount).toBe(1);
    expect(logs).toContainEqual({
      msg: "lifecycle",
      data: expect.objectContaining({
        childId: "child-3",
        eventClass: "aborted",
        terminalLatchFired: true,
      }),
    });
  });

  it("maps provider error to failed", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-manager-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-4", cwd));

    session.rejectPrompt(new Error("provider exploded"));
    const terminal = await handle.wait();

    expect(terminal.class).toBe("failed");
    expect(terminal.error).toBe("provider exploded");
    expect(session.disposed).toBe(true);
    expect(logs).toContainEqual({
      msg: "lifecycle",
      data: expect.objectContaining({
        childId: "child-4",
        eventClass: "failed",
        terminalLatchFired: true,
      }),
    });
  });

  it("disposes live handles on parent session_shutdown and rejects further mail/start", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-manager-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-5", cwd));

    expect(manager.getSessionHandle("child-5")).toBeDefined();
    await manager.disposeAll();

    expect(manager.getSessionHandle("child-5")).toBeUndefined();
    expect(session.disposed).toBe(true);
    expect(session.aborted).toBe(true);
    await expect(handle.wait()).resolves.toMatchObject({ class: "aborted" });
    await expect(handle.steer("hello")).rejects.toThrow(/terminal; further mail is rejected/);
    await expect(handle.followUp("hello")).rejects.toThrow(/terminal; further mail is rejected/);
    await expect(manager.startChild(startOptions("child-6", cwd))).rejects.toThrow(
      /shut down; further start is rejected/,
    );
  });

  it("includes beadwork_show and excludes beadwork mutations, including after late register", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-manager-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    await manager.startChild({
      ...startOptions("child-7", cwd),
      parentToolNames: [
        "read",
        "bash",
        "spawn",
        "halt",
        "beadwork_show",
        "beadwork_comment_issue",
        "beadwork_create_issue",
        "beadwork_close_issue",
      ],
    });

    expect(session.getActiveToolNames()).toContain("beadwork_show");
    expect(session.getActiveToolNames()).not.toContain("beadwork_close_issue");
    expect(session.getActiveToolNames()).not.toContain("beadwork_comment_issue");
    expect(session.getActiveToolNames()).not.toContain("beadwork_create_issue");

    session.registerTool("beadwork_close_issue");
    session.registerTool("beadwork_comment_issue");
    session.registerTool("beadwork_create_issue");
    expect(session.getActiveToolNames()).toContain("beadwork_comment_issue");
    expect(session.getActiveToolNames()).toContain("beadwork_create_issue");

    const names = manager.applyTools("child-7");
    expect(names).toContain("beadwork_show");
    expect(names).not.toContain("beadwork_close_issue");
    expect(names).not.toContain("beadwork_comment_issue");
    expect(names).not.toContain("beadwork_create_issue");
    expect(logs).toContainEqual({
      msg: "tools-filtered",
      data: expect.objectContaining({
        childId: "child-7",
        tools: expect.arrayContaining(["beadwork_show"]),
      }),
    });
  });

  it("does not resurrect a handle when disposeAll races in-flight startChild", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-manager-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    const startPromise = manager.startChild({
      ...startOptions("child-8", cwd),
      toolSyncEnabled: true,
      toolSyncMaxWait: 10_000,
      parentToolNames: ["read", "bash", "never_registers_tool"],
    });
    startPromise.catch(() => {});

    const deadline = Date.now() + 2000;
    while (!manager.getSession("child-8")) {
      if (Date.now() > deadline) throw new Error("child session never registered");
      await new Promise((r) => setTimeout(r, 5));
    }

    await manager.disposeAll();
    await expect(startPromise).rejects.toThrow(/shut down; further start is rejected/);
    expect(manager.getSessionHandle("child-8")).toBeUndefined();
    await expect(manager.startChild(startOptions("child-9", cwd))).rejects.toThrow(
      /shut down; further start is rejected/,
    );
  });

  it("aborts before dispose and keeps dispose single-flight", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-manager-"));
    const session = new FakeChildSession();
    const disposeStarted = createDeferred<void>();
    const continueDispose = createDeferred<void>();
    const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
      createChildRuntime: async () => ({
        runtime: {
          session,
          dispose: async () => {
            disposeStarted.resolve();
            await continueDispose.promise;
            session.dispose();
          },
        },
        sessionPath: join(cwd, "child.jsonl"),
      }),
    });

    const handle = await manager.startChild(startOptions("child-10", cwd));
    handle.abort();
    await disposeStarted.promise;
    const disposeAll = manager.disposeAll();
    continueDispose.resolve();
    await disposeAll;
    await expect(handle.wait()).resolves.toMatchObject({ class: "aborted" });

    expect(session.callOrder.indexOf("abort")).toBeGreaterThanOrEqual(0);
    expect(session.callOrder.indexOf("abort")).toBeLessThan(session.callOrder.indexOf("dispose"));
    expect(session.disposeCount).toBe(1);
    expect(session.aborted).toBe(true);
  });

  it("does not wait for parent-only send_minion_message during tool sync", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-smm-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    spyLogger();

    const started = Date.now();
    await manager.startChild({
      ...startOptions("child-smm", cwd),
      toolSyncEnabled: true,
      toolSyncMaxWait: 5000,
      parentToolNames: ["read", "bash", "spawn", "halt", "orchestrate", SEND_MINION_MESSAGE_TOOL],
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(session.getAllTools().some((tool) => tool.name === SEND_MINION_MESSAGE_TOOL)).toBe(
      false,
    );
    expect(logs.some((entry) => entry.msg === "async-tools-timeout")).toBe(false);
  });

  it("applies trailing turn_end and usage before committing idle", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-trail-turn-"));
    const session = new TrailingEventSession();
    session.getSessionStats = () => ({
      tokens: { input: 3, output: 5, cacheRead: 1, cacheWrite: 2 },
      cost: 0.25,
    });
    const manager = createManager(session, cwd);
    const turns: number[] = [];
    const usage: Array<{ input: number; output: number; cost: number }> = [];

    const handle = await manager.startChild({
      ...startOptions("child-trail-turn", cwd),
      onTurnEnd: (turnCount) => turns.push(turnCount),
      onUsageUpdate: (next) =>
        usage.push({ input: next.input, output: next.output, cost: next.cost }),
    });

    session.queueTrailing({ type: "turn_end" });
    session.queueTrailing({ type: "agent_settled" });
    session.resolvePrompt();

    await expect(handle.wait()).resolves.toMatchObject({ class: "settled", exitCode: 0 });
    expect(turns).toEqual([1]);
    expect(usage).toEqual([{ input: 3, output: 5, cost: 0.25 }]);
  });

  it("classifies trailing auto_retry_end failure as failed, not settled", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-trail-retry-"));
    const session = new TrailingEventSession();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-trail-retry", cwd));

    session.queueTrailing({
      type: "auto_retry_end",
      success: false,
      finalError: "retry exhausted",
    });
    session.resolvePrompt();

    await expect(handle.wait()).resolves.toMatchObject({
      class: "failed",
      exitCode: 1,
      error: "retry exhausted",
    });
  });
});

describe("pending abort before startChild publishes", () => {
  it("aborts before createChildRuntime and never publishes a live handle", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-pending-pre-"));
    const session = new FakeChildSession();
    let created = 0;
    const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
      createChildRuntime: async () => {
        created++;
        return {
          runtime: {
            session,
            dispose: () => {
              session.dispose();
            },
          },
          sessionPath: join(cwd, "child.jsonl"),
        };
      },
    });

    expect(manager.abortSession("child-pre")).toBe(true);
    const handle = await manager.startChild(startOptions("child-pre", cwd));
    const terminal = await handle.wait();

    expect(created).toBe(0);
    expect(terminal.class).toBe("aborted");
    expect(manager.getSessionHandle("child-pre")).toBeUndefined();
    expect(manager.isLive("child-pre")).toBe(false);
    expect(manager.getTerminal("child-pre")?.class).toBe("aborted");
  });

  it("honors abortSession during in-flight startChild and ends aborted not settled", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-pending-inflight-"));
    const session = new FakeChildSession();
    const runtimeGate = createDeferred<void>();
    const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
      createChildRuntime: async () => {
        await runtimeGate.promise;
        return {
          runtime: {
            session,
            dispose: () => {
              session.dispose();
            },
          },
          sessionPath: join(cwd, "child.jsonl"),
        };
      },
    });

    const startPromise = manager.startChild(startOptions("child-pending", cwd));
    startPromise.catch(() => {});
    expect(manager.getSessionHandle("child-pending")).toBeUndefined();
    expect(manager.abortSession("child-pending")).toBe(true);

    runtimeGate.resolve();
    const handle = await startPromise;
    const terminal = await handle.wait();

    expect(terminal.class).toBe("aborted");
    expect(manager.getSessionHandle("child-pending")).toBeUndefined();
    expect(manager.isLive("child-pending")).toBe(false);
    expect(manager.getTerminal("child-pending")?.class).toBe("aborted");
    expect(session.disposed).toBe(true);
  });
});

describe("startChild bindExtensions failure", () => {
  it("disposes child records and records failed when bindExtensions rejects", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-bind-fail-"));
    const failing = new FakeChildSession();
    const succeeding = new FakeChildSession();
    const sessions = [failing, succeeding];
    let created = 0;
    const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
      createChildRuntime: async ({ id }) => {
        const session = sessions[created++] ?? new FakeChildSession();
        return {
          runtime: {
            session,
            dispose: () => {
              session.dispose();
            },
          },
          sessionPath: join(cwd, `${id}.jsonl`),
        };
      },
    });

    let waiter: ReturnType<SubsessionManager["waitForChild"]> | undefined;
    failing.bindExtensions = async () => {
      waiter = manager.waitForChild("child-bind-fail");
      throw new Error("extension session_start failed");
    };

    await expect(manager.startChild(startOptions("child-bind-fail", cwd))).rejects.toThrow(
      /extension session_start failed/,
    );

    expect(manager.getSessionHandle("child-bind-fail")).toBeUndefined();
    expect(manager.getSession("child-bind-fail")).toBeUndefined();
    expect(failing.disposed).toBe(true);
    expect(failing.disposeCount).toBe(1);
    expect(manager.getTerminal("child-bind-fail")?.class).toBe("failed");
    await expect(waiter).resolves.toMatchObject({
      class: "failed",
      error: "extension session_start failed",
    });
    expect(manager.list().find((entry) => entry.sessionId === "child-bind-fail")).toEqual(
      expect.objectContaining({
        sessionId: "child-bind-fail",
        status: "failed",
      }),
    );
    expect(
      manager
        .list()
        .some((entry) => entry.sessionId === "child-bind-fail" && entry.status === "running"),
    ).toBe(false);

    const handle = await manager.startChild(startOptions("child-bind-ok", cwd));
    expect(handle.id).toBe("child-bind-ok");
    expect(manager.getSessionHandle("child-bind-ok")).toBe(handle);
    expect(manager.getSession("child-bind-ok")).toBe(succeeding);
    expect(succeeding.disposed).toBe(false);
  });
});

describe("single terminal latch with inbound mail", () => {
  const logs: Array<{ msg: string; data: Record<string, unknown> }> = [];

  afterEach(() => {
    logs.length = 0;
    vi.restoreAllMocks();
  });

  function spyLogger() {
    vi.spyOn(logger, "info").mockImplementation((scope, msg, data) => {
      if (scope === "subsession") logs.push({ msg, data: (data ?? {}) as Record<string, unknown> });
    });
  }

  function committedLogs() {
    return logs.filter(
      (entry) => entry.msg === "lifecycle" && entry.data.terminalLatchFired === true,
    );
  }

  async function expectOneTerminal(
    handle: { wait: () => Promise<{ class: string }> },
    session: FakeChildSession,
    eventClass: string,
  ) {
    const terminal = await handle.wait();
    expect(terminal.class).toBe(eventClass);
    expect(session.disposed).toBe(true);
    const committed = committedLogs();
    expect(committed).toHaveLength(1);
    expect(committed[0]?.data).toMatchObject({
      eventClass,
      terminalLatchFired: true,
      terminalEventCount: 1,
    });
    return terminal;
  }

  it("mail then settle → one settled after continuation idles; mail delivered", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-mail-settle-"));
    const session = new FakeChildSession();
    session.holdFollowUp();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-ms", cwd));

    const mail = handle.followUp("peer hello");
    await vi.waitFor(() => {
      expect(session.followUps).toEqual(["peer hello"]);
    });

    session.emit({ type: "agent_settled" });
    await Promise.resolve();
    expect(manager.getTerminal("child-ms")).toBeUndefined();
    expect(session.disposed).toBe(false);

    session.releaseFollowUp();
    session.resolveIdle();
    await mail;
    session.emit({ type: "agent_settled" });

    await expectOneTerminal(handle, session, "settled");
    expect(session.followUps).toEqual(["peer hello"]);
    await expect(handle.followUp("too late")).rejects.toThrow(/terminal; further mail is rejected/);
  });

  it("settle commit then mail → recipient-terminal; one terminal event", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-settle-mail-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-sm", cwd));

    session.emit({ type: "agent_settled" });
    await expectOneTerminal(handle, session, "settled");

    await expect(handle.followUp("too late")).rejects.toThrow(/terminal; further mail is rejected/);
    expect(session.followUps).toEqual([]);
    expect(committedLogs()).toHaveLength(1);
  });

  it("failed then mail → recipient-terminal; one failed", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-fail-mail-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-fm", cwd));

    session.rejectPrompt(new Error("provider exploded"));
    await expectOneTerminal(handle, session, "failed");

    await expect(handle.followUp("too late")).rejects.toThrow(/terminal; further mail is rejected/);
    expect(session.followUps).toEqual([]);
    expect(committedLogs()).toHaveLength(1);
  });

  it("mail then failed → one failed; mail delivered; no settle", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-mail-fail-"));
    const session = new FakeChildSession();
    session.holdFollowUp();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-mf", cwd));

    const mail = handle.followUp("peer hello");
    mail.catch(() => {});
    await vi.waitFor(() => {
      expect(session.followUps).toEqual(["peer hello"]);
    });
    expect(manager.getTerminal("child-mf")).toBeUndefined();

    session.rejectPrompt(new Error("provider exploded"));
    session.releaseFollowUp();
    await expectOneTerminal(handle, session, "failed");
    expect(session.followUps).toEqual(["peer hello"]);
    await expect(mail).resolves.toBeUndefined();
  });

  it("shutdown then mail → recipient-terminal; one aborted", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-shut-mail-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-shm", cwd));

    await manager.disposeAll();
    await expectOneTerminal(handle, session, "aborted");

    await expect(handle.followUp("too late")).rejects.toThrow(/terminal; further mail is rejected/);
    expect(session.followUps).toEqual([]);
    expect(committedLogs()).toHaveLength(1);
  });

  it("mail then shutdown → one aborted; no settle", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-mail-shut-"));
    const session = new FakeChildSession();
    session.holdFollowUp();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-msh", cwd));

    const mail = handle.followUp("peer hello");
    mail.catch(() => {});
    await vi.waitFor(() => {
      expect(session.followUps).toEqual(["peer hello"]);
    });
    expect(manager.getTerminal("child-msh")).toBeUndefined();

    await manager.disposeAll();
    await expectOneTerminal(handle, session, "aborted");
    expect(session.followUps).toEqual(["peer hello"]);
    await expect(mail).resolves.toBeUndefined();
  });

  it("halt then mail → recipient-terminal; one aborted", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-halt-mail-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-hm", cwd));

    handle.abort();
    await expectOneTerminal(handle, session, "aborted");

    await expect(handle.followUp("too late")).rejects.toThrow(/terminal; further mail is rejected/);
    expect(session.followUps).toEqual([]);
    expect(committedLogs()).toHaveLength(1);
  });

  it("mail then halt → one aborted; no settle", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-mail-halt-"));
    const session = new FakeChildSession();
    session.holdFollowUp();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-mh", cwd));

    const mail = handle.followUp("peer hello");
    mail.catch(() => {});
    await vi.waitFor(() => {
      expect(session.followUps).toEqual(["peer hello"]);
    });
    expect(manager.getTerminal("child-mh")).toBeUndefined();

    handle.abort();
    await expectOneTerminal(handle, session, "aborted");
    expect(session.followUps).toEqual(["peer hello"]);
    await expect(mail).resolves.toBeUndefined();
  });
});
