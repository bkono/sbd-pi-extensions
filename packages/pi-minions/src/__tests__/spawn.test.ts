import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { ORCHESTRATED_COMM_TOOL_NAMES } from "../orchestration/index.js";
import { runMinionSession } from "../spawn.js";
import {
  BEADWORK_CHILD_INSPECTION_TOOLS,
  computeChildActiveTools,
  type SubsessionManager,
} from "../subsessions/manager.js";
import type { ChildTerminalEvent, CreateMinionSessionOptions } from "../subsessions/types.js";
import { SpawnToolParams, spawn } from "../tools/spawn.js";
import { AgentTree } from "../tree.js";

const PARENT_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "spawn",
  "halt",
  "beadwork_show",
  "beadwork_list_issues",
  "beadwork_close_issue",
  "beadwork_comment_issue",
];

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

describe("SpawnToolParams schema", () => {
  it("keeps agent and does not require description, taskType, or groupId", () => {
    const keys = Object.keys(SpawnToolParams.properties);
    expect(keys).toEqual(["task", "agent", "model", "tasks"]);
    expect(keys).toContain("agent");
    expect(keys).not.toContain("description");
    expect(keys).not.toContain("taskType");
    expect(keys).not.toContain("groupId");

    expect(Check(SpawnToolParams, { task: "review the auth flow" })).toBe(true);
    expect(Check(SpawnToolParams, { task: "review the auth flow", agent: "reviewer" })).toBe(true);
    expect(Check(SpawnToolParams, { tasks: [{ task: "a", agent: "reviewer" }] })).toBe(true);
  });
});

describe("foreground spawn tool", () => {
  const dirs: string[] = [];
  const pendingExecutes: Promise<unknown>[] = [];
  const waiters: Array<ReturnType<typeof createDeferred<ChildTerminalEvent>>> = [];

  afterEach(async () => {
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ class: "settled", exitCode: 0, output: "done" });
    }
    await Promise.allSettled(pendingExecutes.splice(0));
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempCwd(): string {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-spawn-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ "pi-minions": { allowEphemeral: true, toolSync: { enabled: false } } }),
      "utf-8",
    );
    return cwd;
  }

  function harness() {
    const cwd = tempCwd();
    const tree = new AgentTree();
    const started: CreateMinionSessionOptions[] = [];
    const pi = {
      getAllTools: () => PARENT_TOOLS.map((name) => ({ name })),
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      model: undefined,
      modelRegistry: { getAll: () => [], find: () => undefined },
    } as unknown as ExtensionContext;

    const manager = {
      startChild: async (options: CreateMinionSessionOptions) => {
        started.push(options);
        const waiter = createDeferred<ChildTerminalEvent>();
        waiters.push(waiter);
        return {
          id: options.id,
          path: join(cwd, `${options.id}.jsonl`),
          steer: async () => {},
          followUp: async () => {},
          abort: () => {},
          wait: () => waiter.promise,
        };
      },
    } as unknown as SubsessionManager;

    const execute = spawn(tree, pi, manager);
    return { tree, started, execute, ctx, waiters };
  }

  async function startSpawn(
    params: SpawnToolParams,
  ): Promise<
    ReturnType<typeof harness> & { pending: Promise<unknown>; settled: { value: boolean } }
  > {
    const h = harness();
    const settled = { value: false };
    const pending = h.execute("tool-1", params, undefined, undefined, h.ctx).finally(() => {
      settled.value = true;
    });
    pendingExecutes.push(pending);
    await vi.waitFor(() => {
      expect(h.tree.getRoots().length).toBeGreaterThan(0);
    });
    return { ...h, pending, settled };
  }

  it("blocks until every child wait() settles and never joins an orchestration group", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const {
      tree,
      started,
      pending,
      settled,
      waiters: childWaiters,
    } = await startSpawn({
      task: "review the auth flow",
    });

    const spawnNode = tree.getRoots()[0];
    expect(settled.value).toBe(false);
    expect(spawnNode.kind).toBe("spawn");
    expect(spawnNode.groupId).toBeUndefined();
    expect(spawnNode.description).toBeUndefined();
    expect(spawnNode.taskType).toBeUndefined();
    expect(spawnNode.status).toBe("running");
    expect(started).toHaveLength(1);
    expect(started[0]?.extraTools).toEqual([]);
    const customNames = (started[0]?.customTools ?? []).map((tool) => tool.name);
    for (const name of ORCHESTRATED_COMM_TOOL_NAMES) {
      expect(customNames).not.toContain(name);
    }

    tree.add("mn-orch-a", "bravo", "child a prompt", {
      kind: "orchestrated",
      groupId: "grp-1",
      description: "Child A",
    });
    const snapshot = tree.getOrchestratedGroup("grp-1");
    expect(snapshot.map((n) => n.id)).toEqual(["mn-orch-a"]);
    expect(snapshot.some((n) => n.kind === "spawn" || n.id === spawnNode.id)).toBe(false);
    expect(tree.get(spawnNode.id)?.status).toBe("running");

    const names = computeChildActiveTools({
      parentCodingTools: started[0]?.parentToolNames,
      extraTools: started[0]?.extraTools,
    });
    expect(names).toEqual(expect.arrayContaining([...BEADWORK_CHILD_INSPECTION_TOOLS]));
    expect(names).toContain("beadwork_show");
    for (const name of ORCHESTRATED_COMM_TOOL_NAMES) {
      expect(names).not.toContain(name);
    }
    expect(names).not.toContain("beadwork_close_issue");
    expect(names).not.toContain("beadwork_comment_issue");

    expect(info).toHaveBeenCalledWith(
      "comm",
      "inject",
      expect.objectContaining({ childId: spawnNode.id, tools: [], kind: "spawn" }),
    );

    expect(info).toHaveBeenCalledWith(
      "spawn:tool",
      "start",
      expect.objectContaining({ kind: "spawn", groupId: undefined }),
    );
    expect(info).toHaveBeenCalledWith(
      "spawn:tool",
      "child",
      expect.objectContaining({ id: spawnNode.id, kind: "spawn", groupId: undefined }),
    );
    expect(info).toHaveBeenCalledWith(
      "tree",
      "add",
      expect.objectContaining({
        id: spawnNode.id,
        kind: "spawn",
        groupId: undefined,
        taskType: undefined,
        description: undefined,
      }),
    );

    childWaiters[0]?.resolve({ class: "settled", exitCode: 0, output: "auth looks fine" });
    const result = await pending;
    expect(settled.value).toBe(true);
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("completed") }],
    });
    expect(tree.get(spawnNode.id)?.status).toBe("completed");
    expect(tree.getOrchestratedGroup("grp-1").map((n) => n.id)).toEqual(["mn-orch-a"]);
  });

  it("waits for every batch child before returning", async () => {
    const {
      tree,
      started,
      pending,
      settled,
      waiters: childWaiters,
    } = await startSpawn({
      tasks: [{ task: "task a" }, { task: "task b" }],
    });

    expect(settled.value).toBe(false);
    expect(started).toHaveLength(2);
    expect(started.every((opts) => opts.extraTools?.length === 0)).toBe(true);
    expect(tree.getRoots().every((n) => n.kind === "spawn" && n.groupId === undefined)).toBe(true);

    childWaiters[0]?.resolve({ class: "settled", exitCode: 0, output: "a done" });
    await Promise.resolve();
    expect(settled.value).toBe(false);

    childWaiters[1]?.resolve({ class: "settled", exitCode: 0, output: "b done" });
    await pending;
    expect(settled.value).toBe(true);
  });

  it("foreground spawn activity follows shared thinking/tool/settling, not starting...", async () => {
    const activities: string[] = [];
    const h = harness();
    const pending = h.execute(
      "tool-1",
      { task: "review the auth flow" },
      undefined,
      (update) => {
        const details = update.details as {
          activity?: string;
          minions?: Array<{ activity?: string }>;
        };
        const activity = details.minions?.[0]?.activity ?? details.activity;
        if (activity) activities.push(activity);
      },
      h.ctx,
    );
    pendingExecutes.push(pending);
    await vi.waitFor(() => {
      expect(h.started).toHaveLength(1);
    });

    await vi.waitFor(() => {
      expect(h.tree.get(h.started[0]!.id)?.activity?.phase).toBe("thinking");
    });
    expect(activities.at(-1)).toBe("thinking");
    expect(activities).not.toContain("starting...");

    h.started[0]?.onTextDelta?.("drafting", "drafting");
    await vi.waitFor(() => {
      expect(activities.at(-1)).toBe("thinking");
    });

    h.started[0]?.onToolActivity?.({
      type: "start",
      toolName: "read",
      args: { path: "src/auth.ts" },
    });
    await vi.waitFor(() => {
      expect(activities.at(-1)).toBe("→ read src/auth.ts");
    });

    h.started[0]?.onAgentEnd?.({ willRetry: false });
    await vi.waitFor(() => {
      expect(activities.at(-1)).toBe("settling");
    });

    h.waiters[0]?.resolve({ class: "settled", exitCode: 0, output: "done" });
    await pending;
  });

  it("one child text event updates foreground once and leaves zero listeners", async () => {
    const h = harness();
    const signatures: string[] = [];
    const pending = h.execute(
      "tool-1",
      { tasks: [{ task: "task a" }, { task: "task b" }, { task: "task c" }] },
      undefined,
      (update) => {
        const details = update.details as {
          minions?: Array<{ id?: string; activity?: string }>;
        };
        signatures.push(
          (details.minions ?? []).map((m) => `${m.id}:${m.activity ?? ""}`).join("|"),
        );
      },
      h.ctx,
    );
    pendingExecutes.push(pending);
    await vi.waitFor(() => {
      expect(h.started).toHaveLength(3);
    });
    expect(h.tree.listenerCount()).toBe(3);

    const before = signatures.length;
    h.started[0]?.onTextDelta?.("hello", "hello");
    expect(signatures.length - before).toBe(1);

    for (const waiter of h.waiters) {
      waiter.resolve({ class: "settled", exitCode: 0, output: "done" });
    }
    await pending;
    expect(h.tree.listenerCount()).toBe(0);
  });

  it("throw during first synchronization yields startChildCalls=0 and zero listeners", async () => {
    const h = harness();
    let updates = 0;
    const pending = h.execute(
      "tool-1",
      { task: "review the auth flow" },
      undefined,
      () => {
        updates++;
        if (updates === 1) throw new Error("sync boom");
      },
      h.ctx,
    );
    pendingExecutes.push(pending.catch(() => undefined));
    await expect(pending).rejects.toThrow(/failed: sync boom/);
    expect(h.started).toHaveLength(0);
    expect(h.tree.listenerCount()).toBe(0);
  });
});

describe("runMinionSession usage accumulator", () => {
  it("merges onUsageUpdate partials into returned usage instead of leaving zeros", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-usage-"));
    const tree = new AgentTree();
    tree.add("mn-usage", "alpha", "do work");
    const manager = {
      startChild: async (options: CreateMinionSessionOptions) => {
        options.onUsageUpdate?.({
          input: 11,
          output: 7,
          cacheRead: 2,
          cacheWrite: 3,
          cost: 0.25,
        });
        return {
          id: options.id,
          path: join(cwd, `${options.id}.jsonl`),
          steer: async () => {},
          followUp: async () => {},
          abort: () => {},
          wait: async () => ({ class: "settled" as const, exitCode: 0, output: "done" }),
        };
      },
    } as unknown as SubsessionManager;

    const result = await runMinionSession(
      {
        name: "ephemeral",
        description: "test",
        systemPrompt: "You are a minion.",
        source: "ephemeral",
        filePath: "",
      },
      "do work",
      {
        id: "mn-usage",
        name: "alpha",
        modelRegistry: { getAll: () => [], find: () => undefined } as never,
        cwd,
        subsessionManager: manager,
        tree,
      },
    );

    expect(result.usage).toMatchObject({
      input: 11,
      output: 7,
      cacheRead: 2,
      cacheWrite: 3,
      cost: 0.25,
    });
    expect(tree.get("mn-usage")?.usage.input).toBe(11);
    expect(tree.get("mn-usage")?.usage.output).toBe(7);
  });

  it("steers wrap-up at config.steps then force-aborts after grace turns", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-steps-"));
    const tree = new AgentTree();
    tree.add("mn-steps", "alpha", "do work");
    const steer = vi.fn(async () => {});
    const waiter = createDeferred<ChildTerminalEvent>();
    const abortSession = vi.fn(() => {
      waiter.resolve({ class: "aborted", exitCode: 1, output: "" });
      return true;
    });
    let onTurnEnd: ((count: number) => void) | undefined;
    const handle = {
      id: "mn-steps",
      path: join(cwd, "mn-steps.jsonl"),
      steer,
      followUp: async () => {},
      abort: () => {},
      wait: () => waiter.promise,
    };
    const manager = {
      startChild: async (options: CreateMinionSessionOptions) => {
        onTurnEnd = options.onTurnEnd;
        return handle;
      },
      getSessionHandle: () => handle,
      abortSession,
    } as unknown as SubsessionManager;

    const pending = runMinionSession(
      {
        name: "ephemeral",
        description: "test",
        systemPrompt: "You are a minion.",
        source: "ephemeral",
        filePath: "",
        steps: 1,
      },
      "do work",
      {
        id: "mn-steps",
        name: "alpha",
        modelRegistry: { getAll: () => [], find: () => undefined } as never,
        cwd,
        subsessionManager: manager,
        tree,
      },
    );

    await vi.waitFor(() => {
      expect(onTurnEnd).toBeDefined();
    });
    onTurnEnd?.(1);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(expect.stringContaining("STEP LIMIT REACHED"));
    expect(abortSession).not.toHaveBeenCalled();

    onTurnEnd?.(2);
    expect(abortSession).not.toHaveBeenCalled();

    onTurnEnd?.(3);
    const result = await pending;
    expect(abortSession).toHaveBeenCalledWith("mn-steps");
    expect(steer).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("aborted");
    expect(result.error).toContain("Step limit exceeded");
  });
});
