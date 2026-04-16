import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStatePath } from "../../config.js";
import piObservationalMemory from "../../index.js";
import {
  createExtensionTestHarness,
  createFakeCommandContext,
  createFakeUi,
} from "../helpers/extension-harness.js";
import { MockObservationAgents } from "../helpers/mock-agents.js";
import { __clearMockAgents, __installMockAgents } from "../helpers/mock-agents-module.js";
import { createTempStateDir, type TempStateDir } from "../helpers/temp-state-dir.js";

let currentFakeHome = "";
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => currentFakeHome };
});

vi.mock("../../agents.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents.js")>("../../agents.js");
  const mod = await import("../helpers/mock-agents-module.js");
  return { ...actual, ObservationAgents: mod.ObservationAgents };
});

const OM_ENV_KEYS = [
  "OM_OBSERVATION_MESSAGE_TOKENS",
  "OM_REFLECTION_OBSERVATION_TOKENS",
  "OM_OBSERVATION_PROVIDER",
  "OM_OBSERVATION_MODEL",
  "OM_REFLECTION_PROVIDER",
  "OM_REFLECTION_MODEL",
  "OM_OBSERVATION_TEMPERATURE",
  "OM_REFLECTION_TEMPERATURE",
  "OM_OBSERVATION_TIMEOUT",
  "OM_REFLECTION_TIMEOUT",
  "OM_DEBUG",
];

describe("extension: /om command", () => {
  let temp: TempStateDir;
  const sessionId = "test-om-command";
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    currentFakeHome = mkdtempSync(join(tmpdir(), "om-home-"));
    for (const key of OM_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    temp = createTempStateDir();
    __installMockAgents(new MockObservationAgents());
  });

  afterEach(() => {
    __clearMockAgents();
    temp.cleanup();
    for (const key of OM_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  function preloadState(state: Record<string, unknown>) {
    const stateDir = `${temp.stateDir}/.pi/om-state`;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      sessionStatePath(stateDir, sessionId),
      JSON.stringify({
        sessionId,
        observations: "",
        observationTokens: 0,
        updatedAt: Date.now(),
        ...state,
      }),
    );
  }

  it("registers the /om command", async () => {
    const harness = await createExtensionTestHarness(piObservationalMemory);
    expect(harness.commands.has("om")).toBe(true);
  });

  it("shows human-readable OM status by default", async () => {
    preloadState({
      observations: "* 🔴 user prefers concise answers",
      observationTokens: 42,
      currentTask: "Finish the slash command",
      suggestedResponse: "Summarize the command output clearly.",
      lastObservedEntryId: "entry-123",
      lastObservedTimestamp: 1_700_000_000_000,
      lastCycleAt: 1_700_000_000_000,
      lastCycleReason: "turn_end",
      lastCursorMode: "id",
      observeTriggered: true,
      reflectTriggered: false,
      tailEntriesBeforePrune: 12,
      tailEntriesAfterPrune: 4,
      tailTokensBeforePrune: 300,
      tailTokensAfterPrune: 120,
      prunedEntriesCount: 8,
      updatedAt: 1_700_000_100_000,
    });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ui = createFakeUi();
    const ctx = createFakeCommandContext({ cwd: temp.stateDir, sessionId, ui });

    await harness.invokeCommand("om", "", ctx);

    const message = ui.notifications[0]?.message ?? "";
    expect(message).toContain(`Observational memory status · ${sessionId}`);
    expect(message).toContain("Stored observations: yes · 42 tokens");
    expect(message).toContain("Last cycle: turn_end · 2023-11-14 22:13:20 UTC");
    expect(message).toContain("Current task:");
    expect(message).toContain("Finish the slash command");
    expect(message).toContain("Suggested response:");
    expect(message).not.toContain("{\n");
  });

  it("shows formatted observations via /om observations", async () => {
    preloadState({
      observations: "* 🔴 user likes tests\n* 🟡 worker is on formatting",
      currentTask: "Review OM output",
      suggestedResponse: "Call out the key observation bullets.",
      observationTokens: 55,
      updatedAt: 1_700_000_100_000,
    });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ui = createFakeUi();
    const ctx = createFakeCommandContext({ cwd: temp.stateDir, sessionId, ui });

    await harness.invokeCommand("om", "observations", ctx);

    const message = ui.notifications[0]?.message ?? "";
    expect(message).toContain(`Observational memory observations · ${sessionId}`);
    expect(message).toContain("Stored observation tokens: 55");
    expect(message).toContain("Current task:");
    expect(message).toContain("Suggested response:");
    expect(message).toContain("Observations:");
    expect(message).toContain("🔴 user likes tests");
    expect(message).not.toContain("<observations>");
  });

  it("shows usage for unknown subcommands", async () => {
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ui = createFakeUi();
    const ctx = createFakeCommandContext({ cwd: temp.stateDir, sessionId, ui });

    await harness.invokeCommand("om", "wat", ctx);

    expect(ui.notifications[0]?.message).toContain("Usage: /om [status|observations]");
  });
});
