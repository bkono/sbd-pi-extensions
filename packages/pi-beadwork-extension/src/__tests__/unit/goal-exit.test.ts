import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGoalHaltPrompt,
  exitGoalMode,
  GOAL_HALT_CUSTOM_TYPE,
  goalExitLog,
  handleAbandonAction,
  injectGoalHaltContinuation,
  maybeExitGoalOnClosedIssue,
  maybeExitGoalOnClosedScopeDetail,
  scopedGoalEpicId,
  shouldExitGoalOnClosedScopeDetail,
  shouldExitGoalOnIssueClose,
} from "../../actions/goal-exit.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import { dropGoalMode } from "../../session-state.js";
import type { BeadworkIssue, Goal, SessionState } from "../../types.js";
import { createFakeExtensionContext, createFakeUi } from "../helpers/extension-harness.js";

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    goalId: "goal-BW-100",
    scopeIds: ["BW-100"],
    reviewPolicy: "ticket",
    startedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    mode: "run",
    scope: { kind: "epic", id: "BW-100", title: "Ship goal adapter" },
    updatedAt: "2026-08-28T00:00:00.000Z",
    goal: goal(),
    ...overrides,
  };
}

function issue(overrides: Partial<BeadworkIssue> = {}): BeadworkIssue {
  return {
    id: "BW-100",
    title: "Ship goal adapter",
    description: "",
    status: "closed",
    type: "epic",
    priority: 1,
    labels: [],
    blockedBy: [],
    blocks: [],
    assignee: "",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

function createInjector() {
  return {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
}

describe("scoped epic detection", () => {
  it("returns the V1 goal epic only while mode is run", () => {
    expect(scopedGoalEpicId(session())).toBe("BW-100");
    expect(scopedGoalEpicId(session({ mode: "interactive" }))).toBeUndefined();
    expect(scopedGoalEpicId(session({ mode: "neutral", goal: undefined }))).toBeUndefined();
  });

  it("exits only when the closed issue is the scoped epic", () => {
    const running = session();
    expect(shouldExitGoalOnIssueClose(running, issue({ type: "epic", id: "BW-100" }))).toBe(true);
    expect(shouldExitGoalOnIssueClose(running, issue({ type: "task", id: "BW-101" }))).toBe(false);
    expect(shouldExitGoalOnIssueClose(running, issue({ type: "epic", id: "BW-200" }))).toBe(false);
    expect(
      shouldExitGoalOnIssueClose(session({ mode: "interactive" }), issue({ type: "epic" })),
    ).toBe(false);
  });

  it("exits on a closed scoped epic, not on open epics, tickets, or missing detail", () => {
    const running = session();
    expect(
      shouldExitGoalOnClosedScopeDetail(
        running,
        issue({ type: "epic", id: "BW-100", status: "closed" }),
      ),
    ).toBe(true);
    expect(
      shouldExitGoalOnClosedScopeDetail(
        running,
        issue({ type: "epic", id: "BW-100", status: "open" }),
      ),
    ).toBe(false);
    expect(
      shouldExitGoalOnClosedScopeDetail(
        running,
        issue({ type: "task", id: "BW-101", status: "closed" }),
      ),
    ).toBe(false);
    expect(shouldExitGoalOnClosedScopeDetail(running, undefined)).toBe(false);
    expect(
      shouldExitGoalOnClosedScopeDetail(
        session({ mode: "interactive" }),
        issue({ type: "epic", status: "closed" }),
      ),
    ).toBe(false);
  });
});

describe("halt continuation", () => {
  it("instructs the parent to halt the minion group", () => {
    const prompt = buildGoalHaltPrompt("BW-100");
    expect(prompt).toContain("BW-100");
    expect(prompt).toMatch(/halt tool id="group"|id "group"/);
    expect(prompt).toContain("/halt group");
    expect(prompt).toMatch(/forget the open group/i);
    expect(prompt).toContain("Do not orchestrate further work");
  });

  it("uses followUp when the parent is busy and triggerTurn when idle", () => {
    const busy = createInjector();
    const idle = createInjector();
    const prompt = buildGoalHaltPrompt("BW-100");

    expect(injectGoalHaltContinuation(busy, prompt, true)).toEqual({
      path: "sendUserMessage",
      busy: true,
    });
    expect(busy.sendUserMessage).toHaveBeenCalledWith(prompt, { deliverAs: "followUp" });
    expect(busy.sendMessage).not.toHaveBeenCalled();

    expect(injectGoalHaltContinuation(idle, prompt, false)).toEqual({
      path: "sendMessage",
      busy: false,
    });
    expect(idle.sendMessage).toHaveBeenCalledWith(
      {
        customType: GOAL_HALT_CUSTOM_TYPE,
        content: prompt,
        display: true,
      },
      { triggerTurn: true },
    );
    expect(idle.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("exitGoalMode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops run mode, queues a halt continuation, and logs the transition", async () => {
    const logSpy = vi.spyOn(goalExitLog, "info");
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui, isIdle: () => false });
    const pi = createInjector();
    let stored = session();

    const persisted = await exitGoalMode({
      ctx,
      activation: { kind: "active", repoRoot: ctx.cwd },
      config: DEFAULT_CONFIG,
      state: stored,
      deps: {
        pi,
        writeSessionState: async (_ctx, _activation, _config, state) => {
          stored = state;
          return state;
        },
      },
      command: "beadwork_close_issue",
      epicId: "BW-100",
      parentBusy: true,
    });

    expect(persisted.mode).not.toBe("run");
    expect(persisted.mode).toBe("interactive");
    expect(persisted.goal).toBeUndefined();
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("/halt group"), {
      deliverAs: "followUp",
    });
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "exit",
      expect.objectContaining({
        command: "beadwork_close_issue",
        epicId: "BW-100",
        previousMode: "run",
        newMode: "interactive",
        haltContinuationQueued: true,
        injectPath: "sendUserMessage",
        busy: true,
      }),
    );
    expect(ui.notifications.at(-1)?.message).toContain("Goal mode ended for BW-100");
  });

  it("does not exit or queue halt when a ticket is closed", async () => {
    const logSpy = vi.spyOn(goalExitLog, "info");
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui });
    const pi = createInjector();
    const running = session();

    const result = await maybeExitGoalOnClosedIssue({
      ctx,
      activation: { kind: "active", repoRoot: ctx.cwd },
      config: DEFAULT_CONFIG,
      state: running,
      issue: issue({ id: "BW-101", type: "task", title: "Child" }),
      deps: {
        pi,
        writeSessionState: async (_ctx, _activation, _config, state) => state,
      },
      command: "beadwork_close_issue",
      parentBusy: true,
    });

    expect(result.mode).toBe("run");
    expect(result.goal).toEqual(running.goal);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "exit",
      expect.objectContaining({
        command: "beadwork_close_issue",
        epicId: "BW-100",
        previousMode: "run",
        newMode: "run",
        haltContinuationQueued: false,
      }),
    );
  });

  it("does not exit on halt-only: dropGoalMode is the only mode change", () => {
    const running = session();
    expect(running.mode).toBe("run");
    expect(shouldExitGoalOnIssueClose(running, issue({ id: "group", type: "task" }))).toBe(false);
    expect(scopedGoalEpicId(running)).toBe("BW-100");
    expect(dropGoalMode(running).mode).toBe("interactive");
  });
});

describe("maybeExitGoalOnClosedScopeDetail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits goal mode when refresh sees the scoped epic already closed", async () => {
    const logSpy = vi.spyOn(goalExitLog, "info");
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui, isIdle: () => true });
    const pi = createInjector();
    let stored = session();

    const next = await maybeExitGoalOnClosedScopeDetail({
      ctx,
      activation: { kind: "active", repoRoot: ctx.cwd },
      config: DEFAULT_CONFIG,
      state: stored,
      scopeDetail: issue({ type: "epic", id: "BW-100", status: "closed" }),
      deps: {
        pi,
        writeSessionState: async (_ctx, _activation, _config, state) => {
          stored = state;
          return state;
        },
      },
      parentBusy: false,
    });

    expect(next.mode).toBe("interactive");
    expect(stored.mode).toBe("interactive");
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: GOAL_HALT_CUSTOM_TYPE,
        content: expect.stringContaining("/halt group"),
      }),
      { triggerTurn: true },
    );
    expect(logSpy).toHaveBeenCalledWith(
      "exit",
      expect.objectContaining({
        command: "close",
        epicId: "BW-100",
        previousMode: "run",
        newMode: "interactive",
        haltContinuationQueued: true,
      }),
    );
  });

  it("does not exit on a closed ticket or missing scopeDetail", async () => {
    const pi = createInjector();
    const ctx = createFakeExtensionContext({ ui: createFakeUi() });
    const writeSessionState = vi.fn(async (_ctx, _activation, _config, state) => state);
    const running = session();

    const ticketState = await maybeExitGoalOnClosedScopeDetail({
      ctx,
      activation: { kind: "active", repoRoot: ctx.cwd },
      config: DEFAULT_CONFIG,
      state: running,
      scopeDetail: issue({ type: "task", id: "BW-101", status: "closed" }),
      deps: { pi, writeSessionState },
      parentBusy: false,
    });
    const missingState = await maybeExitGoalOnClosedScopeDetail({
      ctx,
      activation: { kind: "active", repoRoot: ctx.cwd },
      config: DEFAULT_CONFIG,
      state: running,
      deps: { pi, writeSessionState },
      parentBusy: false,
    });
    const openState = await maybeExitGoalOnClosedScopeDetail({
      ctx,
      activation: { kind: "active", repoRoot: ctx.cwd },
      config: DEFAULT_CONFIG,
      state: running,
      scopeDetail: issue({ type: "epic", id: "BW-100", status: "open" }),
      deps: { pi, writeSessionState },
      parentBusy: false,
    });

    expect(ticketState.mode).toBe("run");
    expect(missingState.mode).toBe("run");
    expect(openState.mode).toBe("run");
    expect(writeSessionState).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("handleAbandonAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits run and queues halt followUp when the parent is busy", async () => {
    const logSpy = vi.spyOn(goalExitLog, "info");
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui, isIdle: () => false });
    const pi = createInjector();
    let stored = session();

    const handled = await handleAbandonAction({
      subcommand: "abandon",
      ctx,
      deps: {
        pi,
        requireActive: async () => ({
          activation: { kind: "active", repoRoot: ctx.cwd },
          config: DEFAULT_CONFIG,
          state: stored,
        }),
        writeSessionState: async (_ctx, _activation, _config, state) => {
          stored = state;
          return state;
        },
      },
    });

    expect(handled).toBe(true);
    expect(stored.mode).toBe("interactive");
    expect(stored.goal).toBeUndefined();
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("/halt group"), {
      deliverAs: "followUp",
    });
    expect(logSpy).toHaveBeenCalledWith(
      "exit",
      expect.objectContaining({
        command: "abandon",
        epicId: "BW-100",
        previousMode: "run",
        newMode: "interactive",
        haltContinuationQueued: true,
      }),
    );
  });

  it("uses triggerTurn when abandoning an idle parent", async () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui, isIdle: () => true });
    const pi = createInjector();

    await handleAbandonAction({
      subcommand: "abandon",
      ctx,
      deps: {
        pi,
        requireActive: async () => ({
          activation: { kind: "active", repoRoot: ctx.cwd },
          config: DEFAULT_CONFIG,
          state: session(),
        }),
        writeSessionState: async (_ctx, _activation, _config, state) => state,
      },
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: GOAL_HALT_CUSTOM_TYPE, display: true }),
      { triggerTurn: true },
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not queue halt when goal mode is already inactive", async () => {
    const logSpy = vi.spyOn(goalExitLog, "info");
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui });
    const pi = createInjector();

    await handleAbandonAction({
      subcommand: "abandon",
      ctx,
      deps: {
        pi,
        requireActive: async () => ({
          activation: { kind: "active", repoRoot: ctx.cwd },
          config: DEFAULT_CONFIG,
          state: session({ mode: "interactive", goal: undefined }),
        }),
        writeSessionState: async (_ctx, _activation, _config, state) => state,
      },
    });

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ui.notifications.at(-1)?.message).toContain("Goal mode is not active");
    expect(logSpy).toHaveBeenCalledWith(
      "exit",
      expect.objectContaining({
        command: "abandon",
        previousMode: "interactive",
        newMode: "interactive",
        haltContinuationQueued: false,
      }),
    );
  });
});

describe("beadwork does not own halt", () => {
  it("does not import minions runtime from production sources", async () => {
    const files = [
      new URL("../../index.ts", import.meta.url),
      new URL("../../actions/goal-exit.ts", import.meta.url),
      new URL("../../actions/run.ts", import.meta.url),
      new URL("../../session-state.ts", import.meta.url),
    ];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file.pathname).not.toMatch(/pi-minions/);
      expect(source, file.pathname).not.toMatch(/from ["'].*halt\.js["']/);
      expect(source, file.pathname).not.toContain("closeGroup");
      expect(source, file.pathname).not.toContain("abortSession");
    }
  });
});
