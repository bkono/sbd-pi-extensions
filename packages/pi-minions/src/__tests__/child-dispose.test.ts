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
import { describe, expect, it } from "vitest";
import { disposeChildAgentSession } from "../subsessions/manager.js";

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

describe("disposeChildAgentSession", () => {
  it("emits session_shutdown(quit) while the child API is active, then disposes", async () => {
    const { session, probe } = await createProbedSession();

    await disposeChildAgentSession(session);

    expect(probe.events).toEqual(["session_start", "session_shutdown:quit"]);
    expect(probe.apiActiveDuringShutdown).toBe(true);
    expect(isStale(probe.pi)).toBe(true);
  });

  it("disposes after the bound when a shutdown handler never settles", async () => {
    const { session, probe } = await createProbedSession(() => new Promise<never>(() => {}));
    const started = Date.now();

    await disposeChildAgentSession(session, 50);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(probe.events).toContain("session_shutdown:quit");
    expect(isStale(probe.pi)).toBe(true);
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
