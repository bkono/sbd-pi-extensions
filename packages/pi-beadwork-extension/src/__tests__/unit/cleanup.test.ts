import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCleanupAction } from "../../actions/cleanup.js";
import { parseArgv } from "../../argv.js";
import { DEFAULT_CONFIG } from "../../constants.js";
import type { SessionState } from "../../types.js";
import { createFakeExtensionContext, createFakeUi } from "../helpers/extension-harness.js";

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    mode: overrides.mode ?? "run",
    scope: overrides.scope ?? { kind: "epic", id: "BW-100" },
    updatedAt: overrides.updatedAt ?? "2026-08-28T00:00:00.000Z",
    goal: overrides.goal ?? {
      goalId: "goal-1",
      scopeIds: ["BW-100"],
      reviewPolicy: "ticket",
      startedAt: "2026-08-28T00:00:00.000Z",
    },
    ...overrides,
  };
}

function createInjector() {
  return {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
}

function neutralState(): SessionState {
  return {
    mode: "neutral",
    scope: { kind: "none" },
    updatedAt: "2026-08-28T00:02:00.000Z",
  };
}

describe("handleCleanupAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("off from run mode queues halt after reset and persists neutral", async () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui, isIdle: () => false });
    const pi = createInjector();
    let stored = session();
    const order: string[] = [];

    const handled = await handleCleanupAction({
      subcommand: "off",
      parsed: parseArgv(""),
      ctx,
      deps: {
        loadConfig: () => DEFAULT_CONFIG,
        detectActivation: async () => ({ kind: "active", repoRoot: ctx.cwd }),
        readState: async () => stored,
        resetState: async () => {
          order.push("reset");
          stored = neutralState();
          return stored;
        },
        pi,
        parentIsBusy: () => true,
      },
    });

    expect(handled).toBe(true);
    expect(stored.mode).toBe("neutral");
    expect(stored.scope).toEqual({ kind: "none" });
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("/halt group"), {
      deliverAs: "followUp",
    });
    expect(String(pi.sendUserMessage.mock.calls[0]?.[0])).toContain("epic BW-100");
    expect(order).toEqual(["reset"]);
    expect(order[0]).toBe("reset");
    expect(pi.sendUserMessage).toHaveBeenCalled();
    expect(ui.notifications.some((entry) => entry.message.includes("reset to neutral"))).toBe(true);
  });

  it("queues halt with a fallback label when no scoped epic id is present", async () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui, isIdle: () => true });
    const pi = createInjector();
    let stored = session({
      mode: "run",
      scope: { kind: "none" },
      goal: undefined,
    });

    const handled = await handleCleanupAction({
      subcommand: "off",
      parsed: parseArgv(""),
      ctx,
      deps: {
        loadConfig: () => DEFAULT_CONFIG,
        detectActivation: async () => ({ kind: "active", repoRoot: ctx.cwd }),
        readState: async () => stored,
        resetState: async () => {
          stored = neutralState();
          return stored;
        },
        pi,
        parentIsBusy: () => false,
      },
    });

    expect(handled).toBe(true);
    expect(stored.mode).toBe("neutral");
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("epic current goal"),
      }),
      { triggerTurn: true },
    );
    expect(String(pi.sendMessage.mock.calls[0]?.[0]?.content ?? "")).toContain("/halt group");
  });

  it("off from interactive does not queue halt", async () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui, isIdle: () => false });
    const pi = createInjector();
    let stored = session({ mode: "interactive" });

    const handled = await handleCleanupAction({
      subcommand: "off",
      parsed: parseArgv(""),
      ctx,
      deps: {
        loadConfig: () => DEFAULT_CONFIG,
        detectActivation: async () => ({ kind: "active", repoRoot: ctx.cwd }),
        readState: async () => stored,
        resetState: async () => {
          stored = neutralState();
          return stored;
        },
        pi,
        parentIsBusy: () => true,
      },
    });

    expect(handled).toBe(true);
    expect(stored.mode).toBe("neutral");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(ui.notifications.some((entry) => entry.message.includes("reset to neutral"))).toBe(true);
  });

  it("off from already-neutral does not queue halt", async () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui, isIdle: () => true });
    const pi = createInjector();
    const stored = neutralState();

    const handled = await handleCleanupAction({
      subcommand: "off",
      parsed: parseArgv(""),
      ctx,
      deps: {
        loadConfig: () => DEFAULT_CONFIG,
        detectActivation: async () => ({ kind: "active", repoRoot: ctx.cwd }),
        readState: async () => stored,
        resetState: async () => stored,
        pi,
        parentIsBusy: () => false,
      },
    });

    expect(handled).toBe(true);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("returns false for other subcommands", async () => {
    const handled = await handleCleanupAction({
      subcommand: "status",
      parsed: parseArgv(""),
      ctx: createFakeExtensionContext({ ui: createFakeUi() }),
      deps: {
        loadConfig: () => DEFAULT_CONFIG,
        detectActivation: async () => ({ kind: "inactive", detail: "missing" }),
        readState: async () => session(),
        resetState: async () => session(),
        pi: createInjector(),
        parentIsBusy: () => false,
      },
    });

    expect(handled).toBe(false);
  });
});
