import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
  disposeCount = 0;
  callOrder: string[] = [];
  promptDeferred = createDeferred<void>();
  idleDeferred = createDeferred<void>();
  followUps: string[] = [];
  followUpHold?: ReturnType<typeof createDeferred<void>>;
  pendingFollowUps = 0;
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
      "beadwork_comment_issue",
      "beadwork_create_issue",
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

describe("single-winner mail vs terminal", () => {
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
    winner: string,
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
      winner,
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

    await expectOneTerminal(handle, session, "mail-then-settle", "settled");
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
    await expectOneTerminal(handle, session, "settle", "settled");

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
    await expectOneTerminal(handle, session, "fail", "failed");

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
    await expectOneTerminal(handle, session, "fail", "failed");
    expect(session.followUps).toEqual(["peer hello"]);
    await expect(mail).resolves.toBeUndefined();
  });

  it("shutdown then mail → recipient-terminal; winner shutdown", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-shut-mail-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-shm", cwd));

    await manager.disposeAll();
    await expectOneTerminal(handle, session, "shutdown", "aborted");

    await expect(handle.followUp("too late")).rejects.toThrow(/terminal; further mail is rejected/);
    expect(session.followUps).toEqual([]);
    expect(committedLogs()).toHaveLength(1);
  });

  it("mail then shutdown → one aborted, winner shutdown; no settle", async () => {
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
    await expectOneTerminal(handle, session, "shutdown", "aborted");
    expect(session.followUps).toEqual(["peer hello"]);
    await expect(mail).resolves.toBeUndefined();
  });

  it("halt then mail → recipient-terminal; winner abort", async () => {
    spyLogger();
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-halt-mail-"));
    const session = new FakeChildSession();
    const manager = createManager(session, cwd);
    const handle = await manager.startChild(startOptions("child-hm", cwd));

    handle.abort();
    await expectOneTerminal(handle, session, "abort", "aborted");

    await expect(handle.followUp("too late")).rejects.toThrow(/terminal; further mail is rejected/);
    expect(session.followUps).toEqual([]);
    expect(committedLogs()).toHaveLength(1);
  });

  it("mail then halt → one aborted, winner abort; no settle", async () => {
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
    await expectOneTerminal(handle, session, "abort", "aborted");
    expect(session.followUps).toEqual(["peer hello"]);
    await expect(mail).resolves.toBeUndefined();
  });
});
