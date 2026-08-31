import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findAgent, unknownAgentMessage } from "../agents.js";
import { OrchestrationGroupState } from "../orchestration/index.js";
import type { SubsessionManager } from "../subsessions/manager.js";
import type { ChildTerminalEvent, CreateMinionSessionOptions } from "../subsessions/types.js";
import { orchestrate } from "../tools/orchestrate.js";
import { SpawnToolParams, spawn } from "../tools/spawn.js";
import { AgentTree } from "../tree.js";
import { OrchestratedTaskDescriptorSchema } from "../types.js";

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

describe("builtin agent resolution", () => {
  const dirs: string[] = [];
  const pending: Promise<unknown>[] = [];
  const waiters: Array<ReturnType<typeof createDeferred<ChildTerminalEvent>>> = [];

  afterEach(async () => {
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ class: "settled", exitCode: 0, output: "done" });
    }
    await Promise.allSettled(pending.splice(0));
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function isolatedCwd(): string {
    const cwd = mkdtempSync(join(tmpdir(), "pi-minions-builtin-res-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ "pi-minions": { allowEphemeral: true, toolSync: { enabled: false } } }),
      "utf-8",
    );
    return cwd;
  }

  function ctxFor(cwd: string): ExtensionContext {
    return {
      cwd,
      mode: "tui",
      model: undefined,
      modelRegistry: { getAll: () => [], find: () => undefined },
      sessionManager: { getSessionFile: () => undefined },
      getSystemPrompt: () => "",
    } as unknown as ExtensionContext;
  }

  it("spawn and orchestrate resolve worker through the same loader", async () => {
    const cwd = isolatedCwd();
    const ctx = ctxFor(cwd);
    const expected = findAgent("worker", cwd, { agentDir: join(cwd, "no-user"), homeDir: cwd });
    expect(expected?.source).toBe("builtin");
    expect(expected?.thinking).toBe("medium");
    expect(expected?.model).toBeUndefined();

    const spawnStarted: CreateMinionSessionOptions[] = [];
    const tree = new AgentTree();
    const manager = {
      startChild: async (options: CreateMinionSessionOptions) => {
        spawnStarted.push(options);
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

    const spawnPending = spawn(
      tree,
      { getAllTools: () => [{ name: "read" }] } as unknown as ExtensionAPI,
      manager,
    )("tool-spawn", { task: "implement the slice", agent: "worker" }, undefined, undefined, ctx);
    pending.push(spawnPending);
    await vi.waitFor(() => {
      expect(spawnStarted.length).toBe(1);
    });

    const orchStarted: CreateMinionSessionOptions[] = [];
    const orchTree = new AgentTree();
    const orch = orchestrate({
      tree: orchTree,
      pi: { getAllTools: () => [{ name: "read" }] },
      subsessionManager: {
        startChild: async (options: CreateMinionSessionOptions) => {
          orchStarted.push(options);
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
      } as unknown as Pick<SubsessionManager, "startChild" | "getSessionHandle" | "abortSession">,
      groups: new OrchestrationGroupState(),
    });
    await orch(
      "tool-orch",
      {
        tasks: [{ task: "implement the slice", description: "Slice", agent: "worker" }],
      },
      undefined,
      undefined,
      ctx,
    );

    expect(orchStarted).toHaveLength(1);
    const spawnConfig = spawnStarted[0]?.config;
    const orchConfig = orchStarted[0]?.config;
    expect(spawnConfig?.name).toBe("worker");
    expect(orchConfig?.name).toBe("worker");
    expect(spawnConfig?.source).toBe(orchConfig?.source);
    expect(spawnConfig?.thinking).toBe(orchConfig?.thinking);
    expect(spawnConfig?.systemPrompt).toBe(orchConfig?.systemPrompt);
    expect(spawnConfig?.model).toBeUndefined();
    expect(orchConfig?.model).toBeUndefined();
    expect(spawnConfig?.thinking).toBe("medium");
    expect(orchTree.get(orchStarted[0]?.id ?? "")?.agentName).toBe("worker");
    expect(orchTree.get(orchStarted[0]?.id ?? "")).not.toHaveProperty("role");
  });

  it("resolves investigate with no user agent directory", async () => {
    const cwd = isolatedCwd();
    const ctx = ctxFor(cwd);
    const started: CreateMinionSessionOptions[] = [];
    const orch = orchestrate({
      tree: new AgentTree(),
      pi: { getAllTools: () => [{ name: "read" }] },
      subsessionManager: {
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
      } as unknown as Pick<SubsessionManager, "startChild" | "getSessionHandle" | "abortSession">,
      groups: new OrchestrationGroupState(),
    });

    const result = await orch(
      "tool-orch",
      {
        tasks: [{ task: "trace the retry failure", description: "Retry", agent: "investigate" }],
      },
      undefined,
      undefined,
      ctx,
    );
    const details = result.details as { accepted: unknown[]; rejected: unknown[] };
    expect(details.rejected).toEqual([]);
    expect(details.accepted).toHaveLength(1);
    expect(started[0]?.config.name).toBe("investigate");
    expect(started[0]?.config.source).toBe("builtin");
    expect(started[0]?.config.thinking).toBe("high");
    expect(started[0]?.config.systemPrompt).toMatch(/do not modify project files/i);
  });

  it("rejects unknown spawn agents with list_agents guidance", async () => {
    const cwd = isolatedCwd();
    const ctx = ctxFor(cwd);
    const execute = spawn(
      new AgentTree(),
      { getAllTools: () => [{ name: "read" }] } as unknown as ExtensionAPI,
      { startChild: async () => ({}) } as unknown as SubsessionManager,
    );

    await expect(
      execute(
        "tool-spawn",
        { task: "do it", agent: "not-a-real-agent" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(unknownAgentMessage("not-a-real-agent"));
  });

  it("removes role from public spawn and orchestrate schemas", () => {
    expect(Object.keys(SpawnToolParams.properties)).not.toContain("role");
    expect(Object.keys(OrchestratedTaskDescriptorSchema.properties)).toEqual([
      "task",
      "description",
      "agent",
      "taskType",
      "model",
      "domain",
    ]);
    expect(
      Check(OrchestratedTaskDescriptorSchema, { task: "x", description: "y", agent: "worker" }),
    ).toBe(true);
  });
});
