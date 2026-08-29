import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { SubsessionManager } from "../subsessions/manager.js";
import type {
  ChildSession,
  ChildSessionEvent,
  CreateMinionSessionOptions,
} from "../subsessions/types.js";
import type { AgentConfig } from "../types.js";

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
  abortedBash = false;
  promptDeferred = createDeferred<void>();
  idleDeferred = createDeferred<void>();
  state = { messages: [] as unknown[] };

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
    ],
  ) {
    for (const name of toolNames) this.tools.set(name, { name });
    this.active = new Set(toolNames);
  }

  async bindExtensions(): Promise<void> {}

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
    return this.promptDeferred.promise;
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
    this.aborted = true;
    this.idleDeferred.resolve();
    this.promptDeferred.resolve();
  }

  abortBash(): void {
    this.abortedBash = true;
  }

  async steer(_text: string): Promise<void> {}

  waitForIdle(): Promise<void> {
    return this.idleDeferred.promise;
  }

  dispose(): void {
    this.disposed = true;
  }

  getSessionStats() {
    return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
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
    await expect(manager.startChild(startOptions("child-6", cwd))).rejects.toThrow(
      /shut down; further start is rejected/,
    );
  });

  it("includes beadwork_show and excludes beadwork_close_issue, including after late register", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-manager-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    await manager.startChild(startOptions("child-7", cwd));

    expect(session.getActiveToolNames()).toContain("beadwork_show");
    expect(session.getActiveToolNames()).not.toContain("beadwork_close_issue");

    session.registerTool("beadwork_close_issue");
    expect(session.getActiveToolNames()).toContain("beadwork_close_issue");

    const names = manager.applyTools("child-7");
    expect(names).toContain("beadwork_show");
    expect(names).not.toContain("beadwork_close_issue");
    expect(logs).toContainEqual({
      msg: "tools-filtered",
      data: expect.objectContaining({
        childId: "child-7",
        tools: expect.arrayContaining(["beadwork_show"]),
      }),
    });
  });
});
