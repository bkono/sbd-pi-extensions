import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHaltHandler } from "../commands/halt.js";
import { OrchestrationGroupState } from "../orchestration/index.js";
import { SubsessionManager } from "../subsessions/manager.js";
import type {
  ChildSession,
  ChildSessionEvent,
  CreateMinionSessionOptions,
  MinionSessionHandle,
} from "../subsessions/types.js";
import { halt, runHalt } from "../tools/halt.js";
import { AgentTree } from "../tree.js";
import type { AgentConfig } from "../types.js";

const ctx = {} as ExtensionContext;
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function logNode(
  label: string,
  node: { id: string; kind?: string; groupId?: string; status: string },
) {
  console.log(label, {
    id: node.id,
    kind: node.kind ?? "spawn",
    groupId: node.groupId,
    status: node.status,
  });
}

function stubManager(abortSession = vi.fn(() => false)) {
  return {
    getSessionHandle: () => undefined as MinionSessionHandle | undefined,
    abortSession,
  };
}

function openGroup(cwd: string): { groups: OrchestrationGroupState; groupId: string } {
  const groups = new OrchestrationGroupState();
  const resolved = groups.resolveGroup({ parentCwd: cwd });
  if ("reject" in resolved) throw new Error(resolved.reject);
  return { groups, groupId: resolved.groupId };
}

function seedFleet(groupId: string): AgentTree {
  const tree = new AgentTree();
  tree.add("mn-spawn", "alpha", "foreground task");
  tree.add("mn-orch-a", "bravo", "child a prompt", {
    kind: "orchestrated",
    groupId,
    taskType: "implementation",
    description: "Child A",
  });
  tree.add("mn-orch-b", "charlie", "child b prompt", {
    kind: "orchestrated",
    groupId,
    taskType: "reviewImplementation",
    description: "Child B",
  });
  return tree;
}

describe("halt one vs group vs missing", () => {
  it("halts one orchestrated child without forgetting the open group", async () => {
    const cwd = tempDir("pi-minions-halt-one-");
    const { groups, groupId } = openGroup(cwd);
    const tree = seedFleet(groupId);
    const abortSession = vi.fn(() => false);
    const result = await runHalt("mn-orch-a", tree, stubManager(abortSession), groups);

    const node = tree.get("mn-orch-a")!;
    logNode("halt-one", node);

    expect(result.missing).toBeUndefined();
    expect(result.halted).toEqual([
      { id: "mn-orch-a", kind: "orchestrated", groupId, status: "aborted" },
    ]);
    expect(node.status).toBe("aborted");
    expect(tree.get("mn-orch-b")?.status).toBe("running");
    expect(tree.get("mn-spawn")?.status).toBe("running");
    expect(groups.getOpenGroup()?.groupId).toBe(groupId);
    expect(result.groupClosed).toBeUndefined();
    expect(abortSession).not.toHaveBeenCalled();
  });

  it("halts a group, drains members, and forgets the open group for the next orchestrate", async () => {
    const cwd = tempDir("pi-minions-halt-group-");
    const { groups, groupId } = openGroup(cwd);
    const tree = seedFleet(groupId);
    const result = await runHalt(groupId, tree, stubManager(), groups);

    for (const id of ["mn-orch-a", "mn-orch-b", "mn-spawn"]) {
      logNode("halt-group", tree.get(id)!);
    }

    expect(result.groupClosed).toBe(groupId);
    expect(result.halted.map((h) => h.id).sort()).toEqual(["mn-orch-a", "mn-orch-b"]);
    expect(tree.get("mn-orch-a")?.status).toBe("aborted");
    expect(tree.get("mn-orch-b")?.status).toBe("aborted");
    expect(tree.get("mn-spawn")?.status).toBe("running");
    expect(groups.getOpenGroup()).toBeUndefined();

    const next = groups.resolveGroup({ parentCwd: cwd });
    expect("groupId" in next && next.groupId !== groupId).toBe(true);
  });

  it("halts the open group via id=group", async () => {
    const cwd = tempDir("pi-minions-halt-group-alias-");
    const { groups, groupId } = openGroup(cwd);
    const tree = seedFleet(groupId);
    const result = await runHalt("group", tree, stubManager(), groups);
    logNode("halt-group-alias", tree.get("mn-orch-a")!);

    expect(result.groupClosed).toBe(groupId);
    expect(groups.getOpenGroup()).toBeUndefined();
    expect(tree.get("mn-orch-a")?.status).toBe("aborted");
  });

  it("halt all still aborts spawn and orchestrated then forgets the open group", async () => {
    const cwd = tempDir("pi-minions-halt-all-");
    const { groups, groupId } = openGroup(cwd);
    const tree = seedFleet(groupId);
    const result = await runHalt("all", tree, stubManager(), groups);

    for (const id of ["mn-spawn", "mn-orch-a", "mn-orch-b"]) {
      logNode("halt-all", tree.get(id)!);
    }

    expect(result.halted).toHaveLength(3);
    expect(tree.get("mn-spawn")?.status).toBe("aborted");
    expect(tree.get("mn-orch-a")?.status).toBe("aborted");
    expect(tree.get("mn-orch-b")?.status).toBe("aborted");
    expect(result.groupClosed).toBe(groupId);
    expect(groups.getOpenGroup()).toBeUndefined();
  });

  it("returns missing for an unknown id", async () => {
    const cwd = tempDir("pi-minions-halt-missing-");
    const { groups, groupId } = openGroup(cwd);
    const tree = seedFleet(groupId);
    const result = await runHalt("nope", tree, stubManager(), groups);
    expect(result.missing).toBe(true);
    expect(result.error).toBe(true);
    expect(result.text).toBe("Minion not found: nope");

    await expect(
      halt(tree, stubManager() as unknown as SubsessionManager, groups)(
        "tool-1",
        { id: "nope" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("Minion not found: nope");
    expect(tree.get("mn-orch-a")?.status).toBe("running");
  });

  it("notifies command users for missing ids and usage", async () => {
    const cwd = tempDir("pi-minions-halt-cmd-");
    const { groups, groupId } = openGroup(cwd);
    const tree = seedFleet(groupId);
    const notify = vi.fn();
    const handler = createHaltHandler(tree, stubManager() as unknown as SubsessionManager, groups);
    const cmdCtx = { ui: { notify } } as unknown as ExtensionCommandContext;

    await handler("", cmdCtx);
    await handler("nope", cmdCtx);
    expect(notify).toHaveBeenCalledWith("Usage: /halt <id | name | group | all>", "error");
    expect(notify).toHaveBeenCalledWith("Minion not found: nope", "error");
  });
});

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
  tools = new Map<string, { name: string }>([
    ["read", { name: "read" }],
    ["bash", { name: "bash" }],
  ]);
  active = new Set(["read", "bash"]);
  listeners = new Set<(event: ChildSessionEvent) => void>();
  promptDeferred = createDeferred<void>();
  idleDeferred = createDeferred<void>();
  aborted = false;
  disposed = false;
  state = { messages: [] as unknown[] };

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
  prompt(_text: string): Promise<void> {
    return this.promptDeferred.promise;
  }
  abort(): void {
    this.aborted = true;
    this.promptDeferred.resolve();
    this.idleDeferred.resolve();
  }
  abortBash(): void {}
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

function startOptions(id: string, cwd: string): CreateMinionSessionOptions {
  return {
    id,
    name: "minion",
    task: "do the work",
    config: agentConfig,
    spawnedBy: "test",
    cwd,
    modelRegistry: {} as ModelRegistry,
    parentToolNames: ["read", "bash"],
    toolSyncEnabled: false,
  };
}

describe("halt integration abort path", () => {
  it("halt of a running orchestrated child yields aborted status on the tree, not failed", async () => {
    const cwd = tempDir("pi-minions-halt-orch-int-");
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
    const { groups, groupId } = openGroup(cwd);
    const tree = new AgentTree();
    tree.add("orch-1", "bravo", "implement registry", {
      kind: "orchestrated",
      groupId,
      taskType: "implementation",
      description: "Registry refactor",
    });
    await manager.startChild(startOptions("orch-1", cwd));

    const result = await runHalt("orch-1", tree, manager, groups);
    const node = tree.get("orch-1")!;
    logNode("halt-orch-integration", node);

    expect(result.halted).toEqual([
      { id: "orch-1", kind: "orchestrated", groupId, status: "aborted" },
    ]);
    expect(node.status).toBe("aborted");
    expect(node.status).not.toBe("failed");
    expect(manager.getTerminal("orch-1")?.class).toBe("aborted");
    expect(manager.getTerminal("orch-1")?.class).not.toBe("failed");
    expect(session.aborted).toBe(true);
    expect(groups.getOpenGroup()?.groupId).toBe(groupId);

    await manager.disposeAll();
  });

  it("spawn child halt still works as today", async () => {
    const cwd = tempDir("pi-minions-halt-spawn-int-");
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
    const { groups, groupId } = openGroup(cwd);
    const tree = new AgentTree();
    tree.add("spawn-1", "alpha", "foreground task");
    tree.add("orch-keep", "bravo", "still running", {
      kind: "orchestrated",
      groupId,
      description: "Keep",
    });
    await manager.startChild(startOptions("spawn-1", cwd));

    const result = await runHalt("spawn-1", tree, manager, groups);
    const node = tree.get("spawn-1")!;
    logNode("halt-spawn-integration", node);

    expect(node.kind).toBe("spawn");
    expect(node.status).toBe("aborted");
    expect(manager.getTerminal("spawn-1")?.class).toBe("aborted");
    expect(session.aborted).toBe(true);
    expect(tree.get("orch-keep")?.status).toBe("running");
    expect(groups.getOpenGroup()?.groupId).toBe(groupId);
    expect(result.groupClosed).toBeUndefined();

    await manager.disposeAll();
  });
});
