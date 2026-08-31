import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unknownAgentMessage } from "../agents.js";
import registerMinions from "../index.js";
import { logger } from "../logger.js";
import {
  GROUP_REJECT_REASONS,
  ORCHESTRATED_COMM_TOOL_NAMES,
  OrchestrationGroupState,
  type OrchestrationLifecycleEvent,
  PARENT_ONLY_MINION_TOOLS,
} from "../orchestration/index.js";
import { TIMEOUT_GRACE_MS, TIMEOUT_WRAP_UP_MESSAGE } from "../session-timeout.js";
import { createStatusTracker, MINIONS_STATUS_KEY } from "../status.js";
import { STEP_LIMIT_WRAP_UP_MESSAGE } from "../step-limit.js";
import { SubsessionManager } from "../subsessions/manager.js";
import type {
  ChildSession,
  ChildSessionEvent,
  CreateMinionSessionOptions,
  MinionSessionHandle,
} from "../subsessions/types.js";
import { runHalt } from "../tools/halt.js";
import { listMinions } from "../tools/minions.js";
import { isPersistentHost, ORCHESTRATE_REJECT_REASONS, orchestrate } from "../tools/orchestrate.js";
import { AgentTree } from "../tree.js";
import type { OrchestrateInput, OrchestrateResult } from "../types.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
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

const baseTask = {
  task: "Implement the registry refactor",
  description: "Registry refactor",
};

function createCtx(cwd: string, mode: ExtensionContext["mode"] = "tui"): ExtensionContext {
  return {
    cwd,
    mode,
    model: undefined,
    modelRegistry: {
      getAll: () => [],
      find: () => undefined,
    },
    sessionManager: { getSessionFile: () => undefined },
    getSystemPrompt: () => "",
  } as unknown as ExtensionContext;
}

function hangingHandle(id: string, cwd: string): MinionSessionHandle {
  return {
    id,
    path: join(cwd, `${id}.jsonl`),
    steer: async () => {},
    followUp: async () => {},
    abort: () => {},
    wait: () => new Promise(() => {}),
  };
}

function setup(options?: {
  startChild?: ReturnType<typeof vi.fn>;
  extraTools?: string[];
  generateId?: () => string;
}) {
  const cwd = tempDir("pi-minions-orchestrate-");
  const tree = new AgentTree();
  const groups = new OrchestrationGroupState();
  const events: OrchestrationLifecycleEvent[] = [];
  const startChild =
    options?.startChild ?? vi.fn(async (opts: { id: string }) => hangingHandle(opts.id, cwd));
  const execute = orchestrate({
    tree,
    pi: { getAllTools: () => [{ name: "read" }, { name: "bash" }] } as Pick<
      ExtensionAPI,
      "getAllTools"
    >,
    subsessionManager: { startChild } as unknown as Pick<
      SubsessionManager,
      "startChild" | "getSessionHandle" | "abortSession"
    >,
    groups,
    extraTools: options?.extraTools ?? [],
    generateId: options?.generateId,
    onLifecycle: (event) => events.push(event),
  });
  const ctx = createCtx(cwd);
  return { cwd, tree, groups, events, startChild, execute, ctx };
}

async function run(
  execute: ReturnType<typeof orchestrate>,
  params: OrchestrateInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
) {
  return execute("tool-1", params, signal, undefined, ctx);
}

function detailsOf(result: { details?: unknown }): OrchestrateResult {
  return result.details as OrchestrateResult;
}

function logCall(
  label: string,
  data: {
    groupId?: string;
    childId?: string;
    hostMode: string;
    accepted: number;
    rejected: number;
    reasons: string[];
  },
) {
  console.log(label, data);
}

describe("public id collision handling", () => {
  it("retries an occupied spawn id before orchestrated registration", async () => {
    const candidates = ["aaaaaaaa", "bbbbbbbb"];
    const fixture = setup({ generateId: () => candidates.shift() ?? "bbbbbbbb" });
    fixture.tree.add("aaaaaaaa", "foreground", "spawn work", { kind: "spawn" });
    const result = detailsOf(await run(fixture.execute, { tasks: [baseTask] }, fixture.ctx));
    expect(result.accepted[0]?.childId).toBe("bbbbbbbb");
    expect(fixture.tree.get("aaaaaaaa")?.kind).toBe("spawn");
    expect(fixture.tree.get("bbbbbbbb")?.kind).toBe("orchestrated");
  });
});

it("rejects bounded collision exhaustion without overwriting the spawn node", async () => {
  const fixture = setup({ generateId: () => "aaaaaaaa" });
  const original = fixture.tree.add("aaaaaaaa", "foreground", "spawn work", { kind: "spawn" });
  await expect(run(fixture.execute, { tasks: [baseTask] }, fixture.ctx)).rejects.toThrow(
    ORCHESTRATE_REJECT_REASONS.idAllocationFailed,
  );
  expect(fixture.tree.get("aaaaaaaa")).toBe(original);
});

describe("host-mode gate", () => {
  it("rejects print and json with a closed reason; tui and rpc accept", async () => {
    const { execute, ctx, cwd, startChild } = setup();

    for (const mode of ["print", "json"] as const) {
      await expect(run(execute, { tasks: [baseTask] }, { ...ctx, mode })).rejects.toThrow(
        ORCHESTRATE_REJECT_REASONS.nonPersistentHost,
      );
      logCall(`host-${mode}`, {
        hostMode: mode,
        accepted: 0,
        rejected: 0,
        reasons: [ORCHESTRATE_REJECT_REASONS.nonPersistentHost],
      });
    }
    expect(startChild).not.toHaveBeenCalled();
    expect(isPersistentHost("print")).toBe(false);
    expect(isPersistentHost("json")).toBe(false);

    for (const mode of ["tui", "rpc"] as const) {
      const result = detailsOf(await run(execute, { tasks: [baseTask] }, { ...ctx, mode, cwd }));
      expect(result.accepted).toHaveLength(1);
      expect(result.accepted[0]?.state).toBe("starting");
      expect(result.rejected).toEqual([]);
      logCall(`host-${mode}`, {
        groupId: result.groupId,
        childId: result.accepted[0]?.childId,
        hostMode: mode,
        accepted: result.accepted.length,
        rejected: result.rejected.length,
        reasons: [],
      });
    }
    expect(isPersistentHost("tui")).toBe(true);
    expect(isPersistentHost("rpc")).toBe(true);
  });
});

describe("task validation", () => {
  it("rejects missing description and unknown taskType without failing the whole batch", async () => {
    const { execute, ctx } = setup();
    const result = detailsOf(
      await run(
        execute,
        {
          tasks: [
            baseTask,
            { task: "no description" } as OrchestrateInput["tasks"][number],
            {
              ...baseTask,
              description: "Bad type",
              taskType: "validation",
            } as OrchestrateInput["tasks"][number],
          ],
        },
        ctx,
      ),
    );

    logCall("partial-validation", {
      groupId: result.groupId,
      childId: result.accepted[0]?.childId,
      hostMode: ctx.mode,
      accepted: result.accepted.length,
      rejected: result.rejected.length,
      reasons: result.rejected.map((item) => item.reason),
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.state).toBe("starting");
    expect(result.accepted[0]?.description).toBe("Registry refactor");
    expect(result.rejected).toEqual([
      { index: 1, reason: ORCHESTRATE_REJECT_REASONS.missingDescription },
      { index: 2, reason: ORCHESTRATE_REJECT_REASONS.unknownTaskType, value: "validation" },
    ]);
  });
});

describe("group create/join/reject", () => {
  it("omits groupId to create then join; second groupId, cwd mismatch, and missing cwd reject", async () => {
    const { execute, ctx, groups, cwd } = setup();
    const created = detailsOf(await run(execute, { tasks: [baseTask] }, ctx));
    expect(created.groupId).toMatch(/^grp-/);
    expect(groups.getOpenGroup()?.groupId).toBe(created.groupId);
    expect(groups.getOpenGroup()?.cwd).toBe(realpathSync(cwd));

    const joined = detailsOf(await run(execute, { tasks: [baseTask] }, ctx));
    expect(joined.groupId).toBe(created.groupId);

    await expect(run(execute, { groupId: "grp-other", tasks: [baseTask] }, ctx)).rejects.toThrow(
      GROUP_REJECT_REASONS.secondConcurrentGroup,
    );

    const otherCwd = tempDir("pi-minions-orchestrate-other-");
    await expect(run(execute, { cwd: otherCwd, tasks: [baseTask] }, ctx)).rejects.toThrow(
      GROUP_REJECT_REASONS.cwdMismatch,
    );

    await expect(
      run(execute, { cwd: join(cwd, "missing"), tasks: [baseTask] }, ctx),
    ).rejects.toThrow(GROUP_REJECT_REASONS.cwdMissing);

    logCall("group-rejects", {
      groupId: created.groupId,
      hostMode: ctx.mode,
      accepted: joined.accepted.length,
      rejected: 0,
      reasons: [
        GROUP_REJECT_REASONS.secondConcurrentGroup,
        GROUP_REJECT_REASONS.cwdMismatch,
        GROUP_REJECT_REASONS.cwdMissing,
      ],
    });
  });
});

describe("accepted state and start failure", () => {
  it("returns accepted state starting and emits a later failed event on start failure", async () => {
    const startChild = vi.fn(async () => {
      throw new Error("runtime failed");
    });
    const { execute, ctx, events, tree } = setup({ startChild });

    const result = detailsOf(await run(execute, { tasks: [baseTask] }, ctx));
    expect(result.accepted).toEqual([
      {
        childId: result.accepted[0]?.childId,
        description: "Registry refactor",
        state: "starting",
      },
    ]);
    expect(tree.get(result.accepted[0]!.childId)?.kind).toBe("orchestrated");
    expect(tree.get(result.accepted[0]!.childId)?.groupId).toBe(result.groupId);

    await vi.waitFor(() => {
      expect(events.some((event) => event.class === "failed")).toBe(true);
    });

    const failed = events.find((event) => event.class === "failed");
    expect(failed).toMatchObject({
      class: "failed",
      groupId: result.groupId,
      childId: result.accepted[0]?.childId,
      error: "runtime failed",
    });
    expect(failed?.lifecycleId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(failed?.epoch).toBe(1);
    expect(tree.get(result.accepted[0]!.childId)?.status).toBe("failed");

    logCall("start-failed-event", {
      groupId: result.groupId,
      childId: result.accepted[0]?.childId,
      hostMode: ctx.mode,
      accepted: result.accepted.length,
      rejected: result.rejected.length,
      reasons: ["runtime failed"],
    });
  });
});

describe("workItemId uniqueness", () => {
  it("rejects a second live duplicate workItemId and allows reuse after terminal", async () => {
    const { execute, ctx, tree, groups } = setup();
    const first = detailsOf(
      await run(
        execute,
        {
          tasks: [
            { ...baseTask, domain: { source: "beadwork", workItemId: "BW-123" } },
            {
              ...baseTask,
              description: "Dup",
              domain: { source: "beadwork", workItemId: "BW-123" },
            },
          ],
        },
        ctx,
      ),
    );

    expect(first.accepted).toHaveLength(1);
    expect(first.rejected).toEqual([
      {
        index: 1,
        reason: ORCHESTRATE_REJECT_REASONS.duplicateWorkItemId,
        value: "BW-123",
      },
    ]);
    expect(groups.getOpenGroup()?.groupId).toBe(first.groupId);

    await expect(
      run(
        execute,
        { tasks: [{ ...baseTask, domain: { source: "beadwork", workItemId: "BW-123" } }] },
        ctx,
      ),
    ).rejects.toThrow(/0 starting, 1 rejected/);
    await expect(
      run(
        execute,
        { tasks: [{ ...baseTask, domain: { source: "beadwork", workItemId: "BW-123" } }] },
        ctx,
      ),
    ).rejects.toThrow(ORCHESTRATE_REJECT_REASONS.duplicateWorkItemId);
    expect(groups.getOpenGroup()?.groupId).toBe(first.groupId);

    tree.updateStatus(first.accepted[0]!.childId, "completed", 0);
    const reused = detailsOf(
      await run(
        execute,
        { tasks: [{ ...baseTask, domain: { source: "beadwork", workItemId: "BW-123" } }] },
        ctx,
      ),
    );
    expect(reused.accepted).toHaveLength(1);
    expect(reused.rejected).toEqual([]);

    logCall("workItemId", {
      groupId: first.groupId,
      childId: `${first.accepted[0]?.childId},${reused.accepted[0]?.childId}`,
      hostMode: ctx.mode,
      accepted: reused.accepted.length,
      rejected: 1,
      reasons: [ORCHESTRATE_REJECT_REASONS.duplicateWorkItemId],
    });
  });
});

describe("registration abort and startChild wiring", () => {
  it("cancels remaining registration on AbortSignal and does not forward the signal to children", async () => {
    const { execute, ctx, startChild, tree, groups } = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(
      run(
        execute,
        { tasks: [baseTask, { ...baseTask, description: "Two" }] },
        ctx,
        controller.signal,
      ),
    ).rejects.toThrow(/0 starting, 2 rejected/);
    expect(startChild).not.toHaveBeenCalled();
    expect(tree.getRoots()).toEqual([]);
    expect(groups.getOpenGroup()).toBeUndefined();

    const started = detailsOf(await run(execute, { tasks: [baseTask] }, ctx));
    const call = startChild.mock.calls[0]?.[0] as {
      extraTools?: string[];
      customTools?: Array<{ name: string }>;
      signal?: unknown;
    };
    expect(startChild).toHaveBeenCalledWith(
      expect.objectContaining({
        id: started.accepted[0]?.childId,
        cwd: realpathSync(ctx.cwd),
        kind: "orchestrated",
        groupId: started.groupId,
        description: baseTask.description,
      }),
    );
    expect(call.extraTools).toEqual(expect.arrayContaining([...ORCHESTRATED_COMM_TOOL_NAMES]));
    expect(call.customTools?.map((tool) => tool.name)).toEqual([...ORCHESTRATED_COMM_TOOL_NAMES]);
    for (const banned of PARENT_ONLY_MINION_TOOLS) {
      expect(call.customTools?.map((tool) => tool.name)).not.toContain(banned);
    }
    expect(call.signal).toBeUndefined();
  });
});

function writeAgent(
  dir: string,
  folder: "agents" | "minions",
  name: string,
  description: string,
  body: string,
  extraFrontmatter: Record<string, string> = {},
): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
  const agentDir = join(dir, ".pi", folder);
  mkdirSync(agentDir, { recursive: true });
  const extras = Object.entries(extraFrontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  writeFileSync(
    join(agentDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}${extras ? `\n${extras}` : ""}\n---\n\n${body}\n`,
    "utf-8",
  );
}

describe("halt during detached start", () => {
  it("skips startChild when the tree node is already terminal", async () => {
    const { execute, ctx, tree, startChild } = setup();
    tree.onChange(() => {
      for (const node of tree.getRoots()) {
        if (node.status === "pending" || node.status === "running") {
          tree.updateStatus(node.id, "aborted");
        }
      }
    });

    const result = detailsOf(await run(execute, { tasks: [baseTask] }, ctx));
    expect(startChild).not.toHaveBeenCalled();
    expect(tree.get(result.accepted[0]!.childId)?.status).toBe("aborted");
  });

  it("keeps aborted when halt races a later startChild onComplete", async () => {
    const startGate = createDeferred<void>();
    const cwd = tempDir("pi-minions-orchestrate-halt-race-");
    const startChild = vi.fn(
      async (opts: {
        id: string;
        onComplete?: (result: { exitCode: number; output: string; status?: string }) => void;
      }) => {
        await startGate.promise;
        opts.onComplete?.({ exitCode: 0, output: "later settled", status: "completed" });
        return {
          ...hangingHandle(opts.id, cwd),
          wait: async () => ({ class: "aborted" as const, exitCode: 1, output: "" }),
        };
      },
    );
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    const abortSession = vi.fn(() => true);
    const execute = orchestrate({
      tree,
      pi: { getAllTools: () => [{ name: "read" }, { name: "bash" }] } as Pick<
        ExtensionAPI,
        "getAllTools"
      >,
      subsessionManager: { startChild } as unknown as Pick<
        SubsessionManager,
        "startChild" | "getSessionHandle" | "abortSession"
      >,
      groups,
    });

    const result = detailsOf(await run(execute, { tasks: [baseTask] }, createCtx(cwd)));
    const childId = result.accepted[0]!.childId;
    expect(tree.get(childId)?.status).toBe("pending");
    expect(startChild).toHaveBeenCalledTimes(1);

    const haltResult = await runHalt(
      "group",
      tree,
      {
        getSessionHandle: () => undefined,
        abortSession,
      } as unknown as SubsessionManager,
      groups,
      { discardGroup: (groupId) => groups.closeGroup(groupId) },
    );
    expect(haltResult.groupClosed).toBe(result.groupId);
    expect(abortSession).toHaveBeenCalledWith(childId);
    expect(tree.get(childId)?.status).toBe("aborted");
    expect(groups.getOpenGroup()).toBeUndefined();

    startGate.resolve();
    await vi.waitFor(() => {
      expect(startChild).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(tree.get(childId)?.status).toBe("aborted");
  });

  it("enforces agent step limits on orchestrated children", async () => {
    const cwd = tempDir("pi-minions-orch-steps-");
    writeAgent(cwd, "agents", "step-limited", "Limited role", "Do the work", {
      steps: "1",
    });

    const steer = vi.fn(async () => {});
    const abortSession = vi.fn(() => true);
    const handles = new Map<string, MinionSessionHandle>();
    let onTurnEnd: ((count: number) => void) | undefined;
    const startChild = vi.fn(async (opts: CreateMinionSessionOptions) => {
      onTurnEnd = opts.onTurnEnd;
      const handle = {
        ...hangingHandle(opts.id, cwd),
        steer,
      };
      handles.set(opts.id, handle);
      return handle;
    });

    const tree = new AgentTree();
    const execute = orchestrate({
      tree,
      pi: { getAllTools: () => [{ name: "read" }] } as Pick<ExtensionAPI, "getAllTools">,
      subsessionManager: {
        startChild,
        getSessionHandle: (id: string) => handles.get(id),
        abortSession,
      } as unknown as Pick<SubsessionManager, "startChild" | "getSessionHandle" | "abortSession">,
      groups: new OrchestrationGroupState(),
    });

    const result = detailsOf(
      await run(
        execute,
        { tasks: [{ task: "do work", description: "Work", agent: "step-limited" }] },
        createCtx(cwd),
      ),
    );
    expect(result.accepted).toHaveLength(1);
    await vi.waitFor(() => {
      expect(startChild).toHaveBeenCalled();
      expect(onTurnEnd).toBeDefined();
    });
    expect(startChild.mock.calls[0]?.[0]?.config.steps).toBe(1);

    const childId = result.accepted[0]!.childId;
    onTurnEnd?.(1);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(STEP_LIMIT_WRAP_UP_MESSAGE);
    expect(abortSession).not.toHaveBeenCalled();
    expect(tree.get(childId)?.activity?.turn).toBe(1);
    expect(
      tree.get(childId)?.activityHistory?.some((item) => item.summary.includes("turn 1")),
    ).toBe(false);
    expect(tree.get(childId)?.usage.turns).toBe(1);
    expect(tree.getTotalUsage().turns).toBe(1);

    onTurnEnd?.(2);
    expect(abortSession).not.toHaveBeenCalled();

    onTurnEnd?.(3);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(abortSession).toHaveBeenCalledTimes(1);
    expect(abortSession).toHaveBeenCalledWith(childId);
    expect(tree.get(childId)?.activity?.turn).toBe(3);
    expect(tree.get(childId)?.activityHistory?.some((item) => /turn \d/.test(item.summary))).toBe(
      false,
    );
    expect(tree.get(childId)?.usage.turns).toBe(3);
    expect(tree.getTotalUsage().turns).toBe(3);
  });

  it("honors agent timeouts on orchestrated children", async () => {
    vi.useFakeTimers();
    const cwd = tempDir("pi-minions-orch-timeout-");
    writeAgent(cwd, "agents", "timed-role", "Timed role", "Do the work", {
      timeout: "10",
    });

    const steer = vi.fn(async () => {});
    const abort = vi.fn();
    const startChild = vi.fn(async (opts: CreateMinionSessionOptions) => ({
      ...hangingHandle(opts.id, cwd),
      steer,
      abort,
    }));

    const tree = new AgentTree();
    const execute = orchestrate({
      tree,
      pi: { getAllTools: () => [{ name: "read" }] } as Pick<ExtensionAPI, "getAllTools">,
      subsessionManager: {
        startChild,
        getSessionHandle: () => undefined,
        abortSession: vi.fn(),
      } as unknown as Pick<SubsessionManager, "startChild" | "getSessionHandle" | "abortSession">,
      groups: new OrchestrationGroupState(),
    });

    const result = detailsOf(
      await run(
        execute,
        { tasks: [{ task: "do work", description: "Work", agent: "timed-role" }] },
        createCtx(cwd),
      ),
    );
    expect(result.accepted).toHaveLength(1);
    expect(startChild).toHaveBeenCalled();
    expect(startChild.mock.calls[0]?.[0]?.config.timeout).toBe(10);

    // Detached startChild promise then installs the timeout timers.
    await Promise.resolve();
    await Promise.resolve();

    expect(steer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(TIMEOUT_WRAP_UP_MESSAGE);
    expect(abort).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TIMEOUT_GRACE_MS);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledTimes(1);
  });
});

describe("agent resolution cwd", () => {
  it("resolves agents from group cwd, not parent cwd", async () => {
    const parentCwd = tempDir("pi-minions-role-parent-");
    const groupCwd = tempDir("pi-minions-role-group-");
    writeAgent(parentCwd, "agents", "shared-role-xyz", "Parent shared role", "PARENT ONLY");
    writeAgent(parentCwd, "agents", "parent-only-role-xyz", "Parent only role", "PARENT ONLY ROLE");
    writeAgent(groupCwd, "minions", "shared-role-xyz", "Group shared role", "GROUP ROLE");
    writeAgent(groupCwd, "agents", "group-only-role-xyz", "Group only role", "GROUP ONLY ROLE");

    const startChild = vi.fn(
      async (opts: { id: string; config: { name: string; systemPrompt: string }; cwd?: string }) =>
        hangingHandle(opts.id, groupCwd),
    );
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    const execute = orchestrate({
      tree,
      pi: { getAllTools: () => [{ name: "read" }, { name: "bash" }] } as Pick<
        ExtensionAPI,
        "getAllTools"
      >,
      subsessionManager: { startChild } as unknown as Pick<
        SubsessionManager,
        "startChild" | "getSessionHandle" | "abortSession"
      >,
      groups,
    });
    const ctx = createCtx(parentCwd);

    const groupOnly = detailsOf(
      await run(
        execute,
        {
          cwd: groupCwd,
          tasks: [
            {
              task: "do group work",
              description: "Group work",
              agent: "group-only-role-xyz",
            },
          ],
        },
        ctx,
      ),
    );
    expect(groupOnly.accepted).toHaveLength(1);
    expect(groupOnly.rejected).toEqual([]);
    await vi.waitFor(() => expect(startChild).toHaveBeenCalledTimes(1));
    expect(startChild.mock.calls[0]?.[0]?.config?.name).toBe("group-only-role-xyz");
    expect(startChild.mock.calls[0]?.[0]?.config?.systemPrompt).toContain("GROUP ONLY ROLE");
    expect(startChild.mock.calls[0]?.[0]?.cwd).toBe(realpathSync(groupCwd));

    const callsBeforeUnknown = startChild.mock.calls.length;
    await expect(
      run(
        execute,
        {
          tasks: [
            {
              task: "do parent work",
              description: "Parent work",
              agent: "parent-only-role-xyz",
            },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(unknownAgentMessage("parent-only-role-xyz"));
    await expect(
      run(
        execute,
        {
          tasks: [
            {
              task: "do parent work",
              description: "Parent work",
              agent: "parent-only-role-xyz",
            },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/list_agents/);
    expect(startChild.mock.calls.length).toBe(callsBeforeUnknown);
    expect(groups.getOpenGroup()?.groupId).toBe(groupOnly.groupId);

    const shared = detailsOf(
      await run(
        execute,
        {
          tasks: [
            {
              task: "do shared work",
              description: "Shared work",
              agent: "shared-role-xyz",
            },
          ],
        },
        ctx,
      ),
    );
    expect(shared.accepted).toHaveLength(1);
    await vi.waitFor(() => expect(startChild).toHaveBeenCalledTimes(2));
    const sharedCall = startChild.mock.calls.find(
      (call) => call[0]?.config?.name === "shared-role-xyz",
    );
    expect(sharedCall?.[0]?.config?.systemPrompt).toContain("GROUP ROLE");
    expect(sharedCall?.[0]?.config?.systemPrompt).not.toContain("PARENT ONLY");
  });
});

describe("orchestration policy cwd", () => {
  it("loads allowEphemeral from group cwd, not parent cwd", async () => {
    const parentCwd = tempDir("pi-minions-policy-parent-");
    const groupCwd = tempDir("pi-minions-policy-group-");
    mkdirSync(join(parentCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(parentCwd, ".pi", "settings.json"),
      JSON.stringify({ "pi-minions": { allowEphemeral: true } }),
      "utf-8",
    );
    mkdirSync(join(groupCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(groupCwd, ".pi", "settings.json"),
      JSON.stringify({ "pi-minions": { allowEphemeral: false } }),
      "utf-8",
    );

    const startChild = vi.fn(async (opts: { id: string }) => hangingHandle(opts.id, groupCwd));
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    const execute = orchestrate({
      tree,
      pi: { getAllTools: () => [{ name: "read" }, { name: "bash" }] } as Pick<
        ExtensionAPI,
        "getAllTools"
      >,
      subsessionManager: { startChild } as unknown as Pick<
        SubsessionManager,
        "startChild" | "getSessionHandle" | "abortSession"
      >,
      groups,
    });

    await expect(
      run(execute, { cwd: groupCwd, tasks: [baseTask] }, createCtx(parentCwd)),
    ).rejects.toThrow(/0 starting, 1 rejected/);
    await expect(
      run(execute, { cwd: groupCwd, tasks: [baseTask] }, createCtx(parentCwd)),
    ).rejects.toThrow(ORCHESTRATE_REJECT_REASONS.ephemeralDisabled);
    expect(startChild).not.toHaveBeenCalled();
    expect(groups.getOpenGroup()).toBeUndefined();
    expect(tree.getRoots()).toEqual([]);
  });

  it("allows ephemeral when the group cwd enables it even if the parent disables it", async () => {
    const parentCwd = tempDir("pi-minions-policy-parent-off-");
    const groupCwd = tempDir("pi-minions-policy-group-on-");
    mkdirSync(join(parentCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(parentCwd, ".pi", "settings.json"),
      JSON.stringify({
        "pi-minions": { allowEphemeral: false, toolSync: { enabled: true } },
      }),
      "utf-8",
    );
    mkdirSync(join(groupCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(groupCwd, ".pi", "settings.json"),
      JSON.stringify({
        "pi-minions": { allowEphemeral: true, toolSync: { enabled: false } },
      }),
      "utf-8",
    );

    const startChild = vi.fn(async (opts: { id: string }) => hangingHandle(opts.id, groupCwd));
    const execute = orchestrate({
      tree: new AgentTree(),
      pi: { getAllTools: () => [{ name: "read" }, { name: "bash" }] } as Pick<
        ExtensionAPI,
        "getAllTools"
      >,
      subsessionManager: { startChild } as unknown as Pick<
        SubsessionManager,
        "startChild" | "getSessionHandle" | "abortSession"
      >,
      groups: new OrchestrationGroupState(),
    });

    const result = detailsOf(
      await run(execute, { cwd: groupCwd, tasks: [baseTask] }, createCtx(parentCwd)),
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([]);
    await vi.waitFor(() => expect(startChild).toHaveBeenCalledTimes(1));
    expect(startChild.mock.calls[0]?.[0]?.toolSyncEnabled).toBe(false);
  });
});

describe("agent system prompt and model defaults", () => {
  function fakeModel(provider: string, id: string) {
    return { provider, id, name: id };
  }

  it("does not override a named agent system prompt with the parent prompt", async () => {
    const cwd = tempDir("pi-minions-role-prompt-");
    writeAgent(cwd, "agents", "reviewer-role-xyz", "Reviewer role", "ROLE SYSTEM PROMPT");
    const { execute, startChild } = setup();
    const ctx = {
      ...createCtx(cwd),
      getSystemPrompt: () => "PARENT SYSTEM PROMPT",
    };

    const result = detailsOf(
      await run(
        execute,
        {
          tasks: [
            {
              task: "review the change",
              description: "Review",
              agent: "reviewer-role-xyz",
            },
          ],
        },
        ctx,
      ),
    );
    expect(result.accepted).toHaveLength(1);
    await vi.waitFor(() => expect(startChild).toHaveBeenCalledTimes(1));
    const call = startChild.mock.calls[0]?.[0] as {
      parentSystemPrompt?: string;
      config?: { systemPrompt?: string };
    };
    expect(call.parentSystemPrompt).toBeUndefined();
    expect(call.config?.systemPrompt).toContain("ROLE SYSTEM PROMPT");
    expect(call.config?.systemPrompt).not.toContain("PARENT SYSTEM PROMPT");
  });

  it("applies the agent model when the task omits model, and a task model still wins", async () => {
    const cwd = tempDir("pi-minions-role-model-");
    writeAgent(cwd, "agents", "special-model-role-xyz", "Special model role", "ROLE BODY", {
      model: "openai/role-model",
    });
    const parent = fakeModel("openai", "parent-model");
    const roleModel = fakeModel("openai", "role-model");
    const override = fakeModel("openai", "override-model");
    const models = [parent, roleModel, override];
    const startChild = vi.fn(async (opts: { id: string }) => hangingHandle(opts.id, cwd));
    const tree = new AgentTree();
    const groups = new OrchestrationGroupState();
    const execute = orchestrate({
      tree,
      pi: { getAllTools: () => [{ name: "read" }, { name: "bash" }] } as Pick<
        ExtensionAPI,
        "getAllTools"
      >,
      subsessionManager: { startChild } as unknown as Pick<
        SubsessionManager,
        "startChild" | "getSessionHandle" | "abortSession"
      >,
      groups,
    });
    const ctx = {
      ...createCtx(cwd),
      model: parent as never,
      modelRegistry: {
        getAll: () => models as never,
        find: (provider: string, id: string) =>
          models.find((model) => model.provider === provider && model.id === id) as never,
      },
    };

    const defaulted = detailsOf(
      await run(
        execute,
        {
          tasks: [
            {
              task: "use role model",
              description: "Role model",
              agent: "special-model-role-xyz",
            },
          ],
        },
        ctx,
      ),
    );
    expect(defaulted.accepted).toHaveLength(1);
    await vi.waitFor(() => expect(startChild).toHaveBeenCalledTimes(1));
    expect(startChild.mock.calls[0]?.[0]?.parentModel).toEqual(roleModel);

    const overridden = detailsOf(
      await run(
        execute,
        {
          tasks: [
            {
              task: "override model",
              description: "Override model",
              agent: "special-model-role-xyz",
              model: "openai/override-model",
            },
          ],
        },
        ctx,
      ),
    );
    expect(overridden.accepted).toHaveLength(1);
    await vi.waitFor(() => expect(startChild).toHaveBeenCalledTimes(2));
    expect(startChild.mock.calls[1]?.[0]?.parentModel).toEqual(override);
  });
});

describe("extension registration", () => {
  it("registers orchestrate on persistent hosts and keeps spawn blocking", () => {
    const tools = new Map<
      string,
      {
        name: string;
        promptGuidelines?: string[];
        renderCall?: unknown;
        renderResult?: unknown;
      }
    >();
    const pi = {
      registerTool: (tool: {
        name: string;
        promptGuidelines?: string[];
        renderCall?: unknown;
        renderResult?: unknown;
      }) => {
        tools.set(tool.name, tool);
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      on: () => {},
      getThinkingLevel: () => "off",
    };
    registerMinions(pi as unknown as ExtensionAPI);

    expect(tools.has("spawn")).toBe(true);
    expect(tools.has("orchestrate")).toBe(true);
    expect(tools.has("send_minion_message")).toBe(true);
    expect(typeof tools.get("spawn")?.renderCall).toBe("function");
    expect(typeof tools.get("spawn")?.renderResult).toBe("function");
    expect(typeof tools.get("orchestrate")?.renderCall).toBe("function");
    expect(typeof tools.get("orchestrate")?.renderResult).toBe("function");
    expect(tools.get("orchestrate")?.renderCall).not.toBe(tools.get("spawn")?.renderCall);
    expect(tools.get("orchestrate")?.renderResult).not.toBe(tools.get("spawn")?.renderResult);
    expect(tools.get("spawn")?.promptGuidelines?.some((line) => /block/i.test(line))).toBe(true);
    expect(
      tools
        .get("spawn")
        ?.promptGuidelines?.some((line) => /orchestrate for background/i.test(line)),
    ).toBe(true);
    expect(
      tools
        .get("orchestrate")
        ?.promptGuidelines?.some((line) => /spawn when you intend to wait/i.test(line)),
    ).toBe(true);
  });
});

describe("logging", () => {
  it("logs groupId, childId, host mode, accepted/rejected counts, and reasons", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { execute, ctx } = setup();
    const result = detailsOf(
      await run(
        execute,
        {
          tasks: [baseTask, { task: "missing description" } as OrchestrateInput["tasks"][number]],
        },
        ctx,
      ),
    );

    expect(info).toHaveBeenCalledWith(
      "orchestrate",
      "result",
      expect.objectContaining({
        groupId: result.groupId,
        childId: result.accepted[0]?.childId,
        hostMode: "tui",
        accepted: 1,
        rejected: 1,
        reasons: [ORCHESTRATE_REJECT_REASONS.missingDescription],
      }),
    );
  });
});

class FakeChildSession implements ChildSession {
  tools = new Map<string, { name: string }>([
    ["read", { name: "read" }],
    ["bash", { name: "bash" }],
  ]);
  active = new Set(["read", "bash"]);
  listeners = new Set<(event: ChildSessionEvent) => void>();
  promptDeferred = createDeferred<void>();
  idleDeferred = createDeferred<void>();
  promptCalls = 0;
  disposed = false;
  isStreaming = false;
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
    this.promptCalls++;
    this.isStreaming = true;
    return this.promptDeferred.promise.finally(() => {
      this.isStreaming = false;
    });
  }
  abort(): void {
    this.promptDeferred.resolve();
    this.idleDeferred.resolve();
  }
  abortBash(): void {}
  async steer(_text: string): Promise<void> {}
  async followUp(_text: string): Promise<void> {}
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

describe("integration timing", () => {
  it("returns before the child prompt resolves", async () => {
    const cwd = tempDir("pi-minions-orchestrate-int-");
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
    const execute = orchestrate({
      tree,
      pi: { getAllTools: () => [{ name: "read" }, { name: "bash" }] } as Pick<
        ExtensionAPI,
        "getAllTools"
      >,
      subsessionManager: manager,
      groups: new OrchestrationGroupState(),
    });

    const returned = detailsOf(await run(execute, { tasks: [baseTask] }, createCtx(cwd)));
    expect(returned.accepted[0]?.state).toBe("starting");
    expect(session.promptDeferred.promise).toBeInstanceOf(Promise);

    let promptResolved = false;
    void session.promptDeferred.promise.then(() => {
      promptResolved = true;
    });
    await Promise.resolve();
    expect(promptResolved).toBe(false);

    logCall("return-before-prompt", {
      groupId: returned.groupId,
      childId: returned.accepted[0]?.childId,
      hostMode: "tui",
      accepted: returned.accepted.length,
      rejected: returned.rejected.length,
      reasons: [],
    });

    await manager.disposeAll();
  });

  it("does not produce an unhandled rejection when start fails after return", async () => {
    const cwd = tempDir("pi-minions-orchestrate-unhandled-");
    const events: OrchestrationLifecycleEvent[] = [];
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const manager = new SubsessionManager(cwd, join(cwd, "parent.jsonl"), undefined, {
        createChildRuntime: async () => {
          throw new Error("boot failed");
        },
      });
      const execute = orchestrate({
        tree: new AgentTree(),
        pi: { getAllTools: () => [{ name: "read" }, { name: "bash" }] } as Pick<
          ExtensionAPI,
          "getAllTools"
        >,
        subsessionManager: manager,
        groups: new OrchestrationGroupState(),
        onLifecycle: (event) => events.push(event),
      });

      const returned = detailsOf(await run(execute, { tasks: [baseTask] }, createCtx(cwd)));
      expect(returned.accepted[0]?.state).toBe("starting");

      await vi.waitFor(() => {
        expect(events.some((event) => event.class === "failed")).toBe(true);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([]);
      expect(events.find((event) => event.class === "failed")?.error).toBe("boot failed");

      logCall("unhandled-start-failure", {
        groupId: returned.groupId,
        childId: returned.accepted[0]?.childId,
        hostMode: "tui",
        accepted: returned.accepted.length,
        rejected: returned.rejected.length,
        reasons: ["boot failed"],
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("registration liveness", () => {
  it("observes pending before the handle exists, running after started, then terminal", async () => {
    const startGate = createDeferred<void>();
    const waitGate = createDeferred<ChildTerminalEvent>();
    const startChild = vi.fn(async (opts: CreateMinionSessionOptions) => {
      await startGate.promise;
      return {
        id: opts.id,
        path: join(opts.cwd, `${opts.id}.jsonl`),
        steer: async () => {},
        followUp: async () => {},
        abort: () => {},
        wait: async () => {
          const terminal = await waitGate.promise;
          opts.onComplete?.({
            exitCode: terminal.exitCode ?? 0,
            output: terminal.output ?? "",
            status: terminal.class === "settled" ? "completed" : terminal.class,
          });
          return terminal;
        },
      };
    });
    const { execute, ctx, tree, events, groups } = setup({ startChild });
    const result = detailsOf(await run(execute, { tasks: [baseTask] }, ctx));
    const childId = result.accepted[0]!.childId;
    expect(result.accepted[0]?.state).toBe("starting");
    expect(tree.get(childId)?.status).toBe("pending");
    expect(tree.getRunning()).toEqual([]);
    expect(events.some((event) => event.class === "started")).toBe(false);
    expect(groups.getOpenGroup()?.groupId).toBe(result.groupId);

    const listedPending = await listMinions(tree)("tool-1", {}, undefined, undefined, ctx);
    expect(listedPending.details?.minions.map((m) => m.status)).toEqual(["pending"]);
    const listedRunning = await listMinions(tree)(
      "tool-1",
      { status: "running" },
      undefined,
      undefined,
      ctx,
    );
    expect(listedRunning.details?.minions).toEqual([]);

    const setStatus = vi.fn();
    const tracker = createStatusTracker(tree, {} as SubsessionManager, ctx);
    tracker.setUi({
      setStatus,
      theme: { fg: (_color: string, text: string) => text },
    } as never);
    tracker.refresh();
    expect(setStatus).toHaveBeenCalledWith(MINIONS_STATUS_KEY, undefined);

    startGate.resolve();
    await vi.waitFor(() => {
      expect(tree.get(childId)?.status).toBe("running");
    });
    expect(events.some((event) => event.class === "started")).toBe(true);
    expect(tree.getRunning().map((n) => n.id)).toEqual([childId]);

    waitGate.resolve({ class: "settled", exitCode: 0, output: "done" });
    await vi.waitFor(() => {
      expect(tree.get(childId)?.status).toBe("completed");
    });
    expect(tree.getRunning()).toEqual([]);
  });

  it("leaves no newly open group on all-rejected registration", async () => {
    const { execute, ctx, tree, groups, startChild } = setup();
    await expect(
      run(
        execute,
        {
          tasks: [
            { task: "a", description: " " },
            { task: "b", description: " ", taskType: "validation" as never },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/0 starting, 2 rejected/);
    expect(startChild).not.toHaveBeenCalled();
    expect(groups.getOpenGroup()).toBeUndefined();
    expect(tree.getRoots()).toEqual([]);
  });

  it("preserves a pre-existing group when a later batch is all rejected", async () => {
    const { execute, ctx, groups } = setup();
    const first = detailsOf(await run(execute, { tasks: [baseTask] }, ctx));
    expect(groups.getOpenGroup()?.groupId).toBe(first.groupId);
    await expect(
      run(execute, { tasks: [{ task: "later", description: " " }] }, ctx),
    ).rejects.toThrow(/0 starting, 1 rejected/);
    expect(groups.getOpenGroup()?.groupId).toBe(first.groupId);
  });

  it("shows a later boot failure as failed after pending without unhandled rejection", async () => {
    const startGate = createDeferred<void>();
    const startChild = vi.fn(async () => {
      await startGate.promise;
      throw new Error("boot failed");
    });
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { execute, ctx, tree, events } = setup({ startChild });
      const result = detailsOf(await run(execute, { tasks: [baseTask] }, ctx));
      const childId = result.accepted[0]!.childId;
      expect(tree.get(childId)?.status).toBe("pending");
      startGate.resolve();
      await vi.waitFor(() => {
        expect(tree.get(childId)?.status).toBe("failed");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([]);
      expect(events.some((event) => event.class === "failed")).toBe(true);
      expect(events.some((event) => event.class === "started")).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
