import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStatePath } from "../../config.js";
import * as format from "../../format.js";
import piObservationalMemory from "../../index.js";
import { loadSessionState } from "../../state.js";
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
  "OM_OBSERVATION_STAGE_MESSAGE_TOKENS",
  "OM_OBSERVATION_PUBLISH_MESSAGE_TOKENS",
  "OM_OBSERVATION_STAGE_MESSAGE_COUNT",
  "OM_OBSERVATION_PUBLISH_MESSAGE_COUNT",
  "OM_OBSERVATION_STAGE_TOOL_RESULT_TOKENS",
  "OM_OBSERVATION_PUBLISH_TOOL_RESULT_TOKENS",
  "OM_OBSERVATION_MAX_CHUNK_MESSAGE_TOKENS",
  "OM_OBSERVATION_MAX_CHUNK_MESSAGES",
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
    vi.restoreAllMocks();
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
    const render = vi.spyOn(format, "formatStatusReport").mockReturnValue("status-sentinel");
    preloadState({
      observations: "* 🔴 user prefers concise answers",
      observationTokens: 42,
      draftObservations: "* 🔴 user prefers concise answers\n* 🟡 staged follow-up",
      draftObservationTokens: 64,
      draftLastObservedEntryId: "entry-125",
      draftLastObservedTimestamp: 1_700_000_010_000,
      publishTriggered: false,
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

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        observationTokens: 42,
        draftObservationTokens: 64,
        draftLastObservedEntryId: "entry-125",
        currentTask: "Finish the slash command",
        suggestedResponse: "Summarize the command output clearly.",
        observeTriggered: true,
        publishTriggered: false,
        reflectTriggered: false,
      }),
    );
    expect(ui.notifications).toEqual([{ message: "status-sentinel", level: "info" }]);
  });

  it("shows effective thresholds for the active 200k model", async () => {
    const render = vi.spyOn(format, "formatStatusReport").mockReturnValue("status-sentinel");
    preloadState({});

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ui = createFakeUi();
    const ctx = createFakeCommandContext({
      cwd: temp.stateDir,
      sessionId,
      ui,
      model: { contextWindow: 200_000 } as never,
    });

    await harness.invokeCommand("om", "status", ctx);

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        stagingThreshold: 50_494,
        stagingMessageCountThreshold: 48,
        stagingToolResultTokenThreshold: 20_197,
        publishThreshold: 100_988,
        publishMessageCountThreshold: 96,
        publishToolResultTokenThreshold: 50_494,
        reflectionThreshold: 24_000,
      }),
    );
    expect(ui.notifications).toEqual([{ message: "status-sentinel", level: "info" }]);
  });

  it("shows formatted observations via /om observations", async () => {
    const render = vi
      .spyOn(format, "formatObservationsReport")
      .mockReturnValue("observations-sentinel");
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

    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        observations: "* 🔴 user likes tests\n* 🟡 worker is on formatting",
        currentTask: "Review OM output",
        suggestedResponse: "Call out the key observation bullets.",
        observationTokens: 55,
      }),
    );
    expect(ui.notifications).toEqual([{ message: "observations-sentinel", level: "info" }]);
  });

  it("shows usage for unknown subcommands", async () => {
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ui = createFakeUi();
    const ctx = createFakeCommandContext({ cwd: temp.stateDir, sessionId, ui });

    await harness.invokeCommand("om", "wat", ctx);

    expect(ui.notifications).toEqual([{ message: format.OM_COMMAND_USAGE, level: "info" }]);
  });

  it("registers the /om:toggle command", async () => {
    const harness = await createExtensionTestHarness(piObservationalMemory);
    expect(harness.commands.has("om:toggle")).toBe(true);
  });

  it("toggles paused state on first /om:toggle", async () => {
    preloadState({});

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ui = createFakeUi();
    const ctx = createFakeCommandContext({ cwd: temp.stateDir, sessionId, ui });

    await harness.invokeCommand("om:toggle", "", ctx);

    const state = await loadSessionState(`${temp.stateDir}/.pi/om-state`, sessionId);
    expect(state.paused).toBe(true);
  });

  it("toggles back to resumed on second /om:toggle", async () => {
    preloadState({ paused: true });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ui = createFakeUi();
    const ctx = createFakeCommandContext({ cwd: temp.stateDir, sessionId, ui });

    await harness.invokeCommand("om:toggle", "", ctx);

    const state = await loadSessionState(`${temp.stateDir}/.pi/om-state`, sessionId);
    expect(state.paused).toBe(false);
  });

  it("passes paused state to the status renderer", async () => {
    const render = vi.spyOn(format, "formatStatusReport").mockReturnValue("paused-sentinel");
    preloadState({ paused: true });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ui = createFakeUi();
    const ctx = createFakeCommandContext({ cwd: temp.stateDir, sessionId, ui });

    await harness.invokeCommand("om", "status", ctx);

    expect(render).toHaveBeenCalledWith(expect.objectContaining({ paused: true }));
    expect(ui.notifications).toEqual([{ message: "paused-sentinel", level: "info" }]);
  });

  it("passes active state to the status renderer", async () => {
    const render = vi.spyOn(format, "formatStatusReport").mockReturnValue("active-sentinel");
    preloadState({});

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ui = createFakeUi();
    const ctx = createFakeCommandContext({ cwd: temp.stateDir, sessionId, ui });

    await harness.invokeCommand("om", "status", ctx);

    expect(render).toHaveBeenCalledWith(expect.objectContaining({ paused: false }));
    expect(ui.notifications).toEqual([{ message: "active-sentinel", level: "info" }]);
  });
});
