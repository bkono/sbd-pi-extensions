import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { createChildRuntimeHandle, disposeChildAgentSession } from "../subsessions/manager.js";

type ShutdownHandler = (pi: ExtensionAPI) => unknown;

interface Probe {
  events: string[];
  pi?: ExtensionAPI;
  apiActiveDuringShutdown?: boolean;
}

/** A real in-process child session, with one inline extension that records its lifecycle. */
async function createProbedSession(onShutdown?: ShutdownHandler) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-minions-child-dispose-"));
  const probe: Probe = { events: [] };
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        probe.pi = pi;
        pi.on("session_start", () => {
          probe.events.push("session_start");
        });
        pi.on("session_shutdown", (event) => {
          probe.events.push(`session_shutdown:${event.reason}`);
          try {
            pi.getActiveTools();
            probe.apiActiveDuringShutdown = true;
          } catch {
            probe.apiActiveDuringShutdown = false;
          }
          return onShutdown?.(pi);
        });
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
  });
  await session.bindExtensions({});
  return { session, probe };
}

function isStale(pi: ExtensionAPI | undefined): boolean {
  try {
    pi?.getActiveTools();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes("stale");
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("disposeChildAgentSession", () => {
  it("keeps the child API active and dispose pending until async cleanup finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let apiActiveAfterAwait: boolean | undefined;
    const { session, probe } = await createProbedSession(async (pi) => {
      await gate;
      apiActiveAfterAwait = !isStale(pi);
    });

    let settled = false;
    const disposing = disposeChildAgentSession(session).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probe.events).toContain("session_shutdown:quit");
    expect(settled).toBe(false);
    expect(isStale(probe.pi)).toBe(false);

    release();
    await disposing;
    expect(apiActiveAfterAwait).toBe(true);
    expect(isStale(probe.pi)).toBe(true);
  });

  it("emits session_shutdown(quit) while the child API is active, then disposes", async () => {
    const { session, probe } = await createProbedSession();

    await disposeChildAgentSession(session);

    expect(probe.events).toEqual(["session_start", "session_shutdown:quit"]);
    expect(probe.apiActiveDuringShutdown).toBe(true);
    expect(isStale(probe.pi)).toBe(true);
  });

  it("disposes after the bound and logs the timeout when a handler never settles", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { session, probe } = await createProbedSession(() => new Promise<never>(() => {}));
    const started = Date.now();

    await disposeChildAgentSession(session, { shutdownTimeoutMs: 50, childId: "child-hung" });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(probe.events).toContain("session_shutdown:quit");
    expect(isStale(probe.pi)).toBe(true);
    expect(warn).toHaveBeenCalledWith("subsession", "child-shutdown-timeout", {
      childId: "child-hung",
      timeoutMs: 50,
    });
  });

  it("does not log a timeout when shutdown completes", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { session } = await createProbedSession();

    await disposeChildAgentSession(session);

    expect(warn).not.toHaveBeenCalled();
  });

  it("disposes when a shutdown handler throws", async () => {
    const { session, probe } = await createProbedSession(() => {
      throw new Error("handler failed");
    });

    await disposeChildAgentSession(session);

    expect(probe.events).toContain("session_shutdown:quit");
    expect(isStale(probe.pi)).toBe(true);
  });

  it("disposes when the extension runner itself rejects", async () => {
    let disposed = false;
    const session = {
      abort: () => Promise.resolve(),
      abortBash: () => {},
      extensionRunner: { emit: () => Promise.reject(new Error("runner failed")) },
      dispose: () => {
        disposed = true;
      },
    } as unknown as AgentSession;

    await disposeChildAgentSession(session);

    expect(disposed).toBe(true);
  });
});

describe("createChildRuntimeHandle", () => {
  it("routes the minion runtime's dispose through session_shutdown", async () => {
    const { session, probe } = await createProbedSession();
    const runtime = createChildRuntimeHandle(session, "child-1");

    await runtime.dispose();

    expect(runtime.session).toBe(session);
    expect(probe.events).toEqual(["session_start", "session_shutdown:quit"]);
    expect(isStale(probe.pi)).toBe(true);
  });
});
