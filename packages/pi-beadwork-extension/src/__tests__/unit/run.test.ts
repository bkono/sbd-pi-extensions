import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGoalRunPrompt,
  collectRejectedRunFlags,
  conflictingGoalEpicId,
  executeRunAction,
  handleRunAction,
  injectGoalRunPrompt,
  isPersistentHost,
  type RunActionDeps,
  runActionLog,
  validateOpenEpicWithDescendants,
} from "../../actions/run.js";
import { parseArgv } from "../../argv.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import { loadSessionState, resolveSessionStateDir, saveSessionState } from "../../session-state.js";
import type {
  ActivationState,
  BeadworkIssue,
  BeadworkIssueDetail,
  Goal,
  SessionState,
} from "../../types.js";
import { createFakeExtensionContext, createFakeUi } from "../helpers/extension-harness.js";

function issue(overrides: Partial<BeadworkIssue> = {}): BeadworkIssue {
  return {
    id: overrides.id ?? "BW-101",
    title: overrides.title ?? "Child task",
    description: overrides.description ?? "",
    status: overrides.status ?? "open",
    type: overrides.type ?? "task",
    priority: overrides.priority ?? 2,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    blocks: overrides.blocks ?? [],
    assignee: overrides.assignee ?? "",
    createdAt: overrides.createdAt ?? "2026-08-28T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-28T00:00:00.000Z",
    parentId: overrides.parentId ?? "BW-100",
  };
}

function epic(overrides: Partial<BeadworkIssueDetail> = {}): BeadworkIssueDetail {
  return {
    id: overrides.id ?? "BW-100",
    title: overrides.title ?? "Ship goal adapter",
    description: overrides.description ?? "",
    status: overrides.status ?? "open",
    type: overrides.type ?? "epic",
    priority: overrides.priority ?? 1,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    blocks: overrides.blocks ?? [],
    assignee: overrides.assignee ?? "",
    createdAt: overrides.createdAt ?? "2026-08-28T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-28T00:00:00.000Z",
    parentId: overrides.parentId,
    children: overrides.children ?? [issue()],
  };
}

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    mode: overrides.mode ?? "interactive",
    scope: overrides.scope ?? { kind: "none" },
    updatedAt: overrides.updatedAt ?? "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

function activation(repoRoot: string): ActivationState {
  return { kind: "active", repoRoot };
}

function createInjector() {
  return {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
}

async function writeProjectConfig(repoRoot: string, config: unknown): Promise<void> {
  await mkdir(path.join(repoRoot, ".pi"), { recursive: true });
  await writeFile(
    path.join(repoRoot, ".pi", "beadwork-config.json"),
    JSON.stringify(config),
    "utf8",
  );
}

function createDeps(input: {
  cwd: string;
  state?: SessionState;
  epic?: BeadworkIssueDetail;
  ready?: BeadworkIssue[];
  pi?: ReturnType<typeof createInjector>;
}): {
  deps: RunActionDeps;
  pi: ReturnType<typeof createInjector>;
  adapter: { show: ReturnType<typeof vi.fn>; ready: ReturnType<typeof vi.fn> };
} {
  const pi = input.pi ?? createInjector();
  let current = input.state ?? session();
  const adapter = {
    show: vi.fn().mockResolvedValue(input.epic ?? epic()),
    ready: vi.fn().mockResolvedValue(input.ready ?? []),
  };

  const deps: RunActionDeps = {
    pi,
    adapter: adapter as unknown as RunActionDeps["adapter"],
    requireActive: async () => ({
      activation: activation(input.cwd),
      config: DEFAULT_CONFIG,
      state: current,
    }),
    ensurePrime: async (_ctx, _activation, _config, state) => state,
    setSessionMode: async (_ctx, _activation, _config, state, mode, scope) => {
      current = {
        ...state,
        mode,
        scope: scope ?? state.scope,
        engagedAt: "2026-08-28T00:01:00.000Z",
      };
      return { state: current };
    },
    writeSessionState: async (_ctx, _activation, _config, state) => {
      current = state;
      await saveSessionState(
        resolveSessionStateDir(input.cwd, DEFAULT_CONFIG.storage.sessionStateDir),
        "test-session-123",
        state,
      );
      return state;
    },
  };

  return { deps, pi, adapter };
}

describe("run flag and host validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects canonical names for kebab and camel supervisor flags", () => {
    const parsed = parseArgv(
      "BW-100 --workers 3 --until blocked --max-cycles 4 --noSpawn --dry-run",
    );

    expect(collectRejectedRunFlags(parsed.options)).toEqual([
      "workers",
      "until",
      "maxCycles",
      "noSpawn",
      "dryRun",
    ]);
  });

  it("accepts tui/rpc hosts and rejects print/json", () => {
    expect(isPersistentHost("tui")).toBe(true);
    expect(isPersistentHost("rpc")).toBe(true);
    expect(isPersistentHost("print")).toBe(false);
    expect(isPersistentHost("json")).toBe(false);
    expect(isPersistentHost(undefined)).toBe(false);
  });

  it("rejects supervisor flags and logs the canonical names", async () => {
    const logSpy = vi.spyOn(runActionLog, "info");
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui, mode: "tui" });
    const { deps } = createDeps({ cwd: ctx.cwd });

    const handled = await handleRunAction({
      subcommand: "run",
      parsed: parseArgv("BW-100 --workers 2 --max-cycles 3 --no-spawn"),
      ctx,
      deps,
    });

    expect(handled).toBe(true);
    expect(ui.notifications.at(-1)?.level).toBe("error");
    expect(ui.notifications.at(-1)?.message).toContain("--workers");
    expect(ui.notifications.at(-1)?.message).toContain("--maxCycles");
    expect(ui.notifications.at(-1)?.message).toContain("--noSpawn");
    expect(logSpy).toHaveBeenCalledWith(
      "reject-flags",
      expect.objectContaining({
        rejectedFlags: ["workers", "maxCycles", "noSpawn"],
        hostMode: "tui",
      }),
    );
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
    expect(deps.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("rejects print and json hosts before injecting", async () => {
    const logSpy = vi.spyOn(runActionLog, "info");

    for (const hostMode of ["print", "json"] as const) {
      const ui = createFakeUi();
      const ctx = createFakeExtensionContext({ ui, mode: hostMode });
      const { deps } = createDeps({ cwd: ctx.cwd });

      await handleRunAction({
        subcommand: "run",
        parsed: parseArgv("BW-100"),
        ctx,
        deps,
      });

      expect(ui.notifications.at(-1)?.level).toBe("error");
      expect(ui.notifications.at(-1)?.message).toMatch(/print and json/);
      expect(logSpy).toHaveBeenCalledWith("reject-host", expect.objectContaining({ hostMode }));
      expect(deps.pi.sendMessage).not.toHaveBeenCalled();
    }
  });
});

describe("epic validation", () => {
  it("rejects non-epics, closed epics, and epics without descendants", () => {
    expect(validateOpenEpicWithDescendants(epic({ type: "task", children: [issue()] }))).toMatch(
      /is a task/,
    );
    expect(validateOpenEpicWithDescendants(epic({ status: "closed" }))).toMatch(/is closed/);
    expect(validateOpenEpicWithDescendants(epic({ children: [] }))).toMatch(
      /traversable descendants/,
    );
    expect(validateOpenEpicWithDescendants(epic())).toBeUndefined();
  });

  it("notifies when the target is not an open epic with descendants", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-epic-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui });
    const { deps } = createDeps({
      cwd: tempDir,
      epic: epic({ type: "task", id: "BW-101", children: [] }),
    });

    await executeRunAction({ ctx, deps, epicId: "BW-101" });

    expect(ui.notifications.at(-1)?.level).toBe("warning");
    expect(ui.notifications.at(-1)?.message).toContain("BW-101 is a task");
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("goal conflict and retry", () => {
  it("treats a different active epic as a conflict and same epic as retry", () => {
    const active: Goal = {
      goalId: "goal-BW-100",
      scopeIds: ["BW-100"],
      reviewPolicy: "ticket",
      startedAt: "2026-08-28T00:00:00.000Z",
    };

    expect(conflictingGoalEpicId(session({ mode: "run", goal: active }), "BW-200")).toBe("BW-100");
    expect(conflictingGoalEpicId(session({ mode: "run", goal: active }), "BW-100")).toBeUndefined();
    expect(
      conflictingGoalEpicId(session({ mode: "interactive", goal: active }), "BW-200"),
    ).toBeUndefined();
  });

  it("re-injects the prompt for the same epic and rejects a different epic", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-conflict-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "test-session-123" });
    const { deps, adapter } = createDeps({ cwd: tempDir });

    await executeRunAction({ ctx, deps, epicId: "BW-100" });
    expect(deps.pi.sendMessage).toHaveBeenCalledTimes(1);

    adapter.show.mockResolvedValueOnce(epic());
    await executeRunAction({ ctx, deps, epicId: "BW-100" });
    expect(deps.pi.sendMessage).toHaveBeenCalledTimes(2);

    adapter.show.mockResolvedValueOnce(
      epic({ id: "BW-200", title: "Other epic", children: [issue({ id: "BW-201" })] }),
    );
    await executeRunAction({ ctx, deps, epicId: "BW-200" });

    expect(ui.notifications.at(-1)?.level).toBe("error");
    expect(ui.notifications.at(-1)?.message).toContain("already running for BW-100");
    expect(ui.notifications.at(-1)?.message).toContain("BW-200");
    expect(deps.pi.sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe("injected goal prompt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("contains identifiers and a refresh instruction, not a copied ready list", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-prompt-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "test-session-123" });
    const readyTicket = issue({ id: "BW-999", title: "Ready ticket that must not be frozen" });
    const { deps, adapter, pi } = createDeps({
      cwd: tempDir,
      ready: [readyTicket],
    });

    await executeRunAction({ ctx, deps, epicId: "BW-100" });

    expect(adapter.ready).not.toHaveBeenCalled();
    const sent = pi.sendMessage.mock.calls[0]?.[0] as { content?: string } | undefined;
    const prompt = sent?.content ?? "";
    expect(prompt).toContain("BW-100");
    expect(prompt).toContain("Ship goal adapter");
    expect(prompt).toContain("Review policy: ticket");
    expect(prompt).toMatch(/Refresh `bw` \(ready\/show\)/);
    expect(prompt).toMatch(/orchestrate/);
    expect(prompt).toContain('source "beadwork"');
    expect(prompt).not.toContain("BW-999");
    expect(prompt).not.toContain("Ready ticket that must not be frozen");
    expect(prompt).not.toContain("[BEADWORK SESSION ACTIVE]");
    expect(prompt).not.toContain("Goal mode: run the scoped epic to completion.");

    expect(
      ui.notifications.some((entry) => entry.message.includes("Goal mode started for BW-100")),
    ).toBe(true);
    expect(
      ui.notifications.some((entry) => entry.message.includes("parent was asked to orchestrate")),
    ).toBe(true);
  });

  it("does not embed a baked ready-ticket list in buildGoalRunPrompt", () => {
    const prompt = buildGoalRunPrompt({
      epicId: "BW-100",
      epicTitle: "Ship goal adapter",
      reviewPolicy: "scope",
    });

    expect(prompt).toContain("BW-100");
    expect(prompt).toContain("Review policy: scope");
    expect(prompt).not.toContain("BW-101");
    expect(prompt).not.toContain("BW-999");
  });

  it("uses followUp when the parent is busy and triggerTurn when idle", () => {
    const busy = createInjector();
    const idle = createInjector();
    const prompt = buildGoalRunPrompt({
      epicId: "BW-100",
      epicTitle: "Ship goal adapter",
      reviewPolicy: "ticket",
    });

    expect(injectGoalRunPrompt(busy, prompt, true)).toEqual({
      path: "sendUserMessage",
      busy: true,
    });
    expect(busy.sendUserMessage).toHaveBeenCalledWith(prompt, { deliverAs: "followUp" });
    expect(busy.sendMessage).not.toHaveBeenCalled();

    expect(injectGoalRunPrompt(idle, prompt, false)).toEqual({
      path: "sendMessage",
      busy: false,
    });
    expect(idle.sendMessage).toHaveBeenCalledWith(
      {
        customType: "beadwork-goal-run",
        content: prompt,
        display: true,
      },
      { triggerTurn: true },
    );
    expect(idle.sendUserMessage).not.toHaveBeenCalled();
  });

  it("injects followUp for a busy parent and triggerTurn when idle, and logs the path", async () => {
    const logSpy = vi.spyOn(runActionLog, "info");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-inject-"));

    const busyUi = createFakeUi();
    const busyCtx = createFakeExtensionContext({
      cwd: tempDir,
      ui: busyUi,
      sessionId: "session-busy",
      isIdle: () => false,
    });
    const busy = createDeps({ cwd: tempDir });
    busy.deps.writeSessionState = async (_ctx, _activation, _config, state) => state;

    await executeRunAction({ ctx: busyCtx, deps: busy.deps, epicId: "BW-100" });
    expect(busy.pi.sendUserMessage).toHaveBeenCalledWith(expect.any(String), {
      deliverAs: "followUp",
    });
    expect(busy.pi.sendMessage).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "inject",
      expect.objectContaining({
        epicId: "BW-100",
        hostMode: "tui",
        injectPath: "sendUserMessage",
        busy: true,
      }),
    );

    const idleUi = createFakeUi();
    const idleCtx = createFakeExtensionContext({
      cwd: tempDir,
      ui: idleUi,
      sessionId: "session-idle",
      isIdle: () => true,
    });
    const idle = createDeps({ cwd: tempDir });
    idle.deps.writeSessionState = async (_ctx, _activation, _config, state) => state;

    await executeRunAction({ ctx: idleCtx, deps: idle.deps, epicId: "BW-100" });
    expect(idle.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "beadwork-goal-run", display: true }),
      { triggerTurn: true },
    );
    expect(idle.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "inject",
      expect.objectContaining({
        epicId: "BW-100",
        hostMode: "tui",
        injectPath: "sendMessage",
        busy: false,
      }),
    );
  });

  it("stores a V1 goal and does not auto-resume workers from an interrupted run", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-goal-"));
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui, sessionId: "test-session-123" });
    const { deps } = createDeps({
      cwd: tempDir,
      state: session({
        mode: "run",
        scope: { kind: "epic", id: "BW-100", title: "Ship goal adapter" },
        runInterrupted: true,
        goal: {
          goalId: "goal-BW-100",
          scopeIds: ["BW-100"],
          reviewPolicy: "ticket",
          startedAt: "2026-08-27T00:00:00.000Z",
        },
      }),
    });

    await executeRunAction({ ctx, deps, epicId: "BW-100" });

    const persisted = await loadSessionState(
      resolveSessionStateDir(tempDir, DEFAULT_CONFIG.storage.sessionStateDir),
      "test-session-123",
    );
    expect(persisted.mode).toBe("run");
    expect(persisted.goal).toEqual({
      goalId: "goal-BW-100",
      scopeIds: ["BW-100"],
      reviewPolicy: "ticket",
      startedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(persisted.runOptions).toBeUndefined();
    expect(persisted.trackedWorkerIds).toBeUndefined();
    expect(deps.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses goal-mode start when supervisor leftovers are configured", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-run-supervisor-"));
    await writeProjectConfig(tempDir, { tmux: { sessionName: "pi-bw" } });
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ cwd: tempDir, ui });
    const { deps } = createDeps({ cwd: tempDir });

    await executeRunAction({ ctx, deps, epicId: "BW-100" });

    expect(ui.notifications.at(-1)?.level).toBe("error");
    expect(ui.notifications.at(-1)?.message).toContain("tmux.sessionName");
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("run.ts cutover source", () => {
  it("no longer launches tmux workers from this path", async () => {
    const source = await readFile(new URL("../../actions/run.ts", import.meta.url), "utf8");
    expect(source).not.toContain("runBoundedEpicLoop");
    expect(source).not.toContain("buildRunOptions");
    expect(source).not.toContain('from "../orchestrator.js"');
  });
});
