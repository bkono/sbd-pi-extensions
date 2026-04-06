import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStatePath } from "../../config.js";
import piObservationalMemory from "../../index.js";
import {
  createExtensionTestHarness,
  createFakeExtensionContext,
} from "../helpers/extension-harness.js";
import { MockObservationAgents } from "../helpers/mock-agents.js";
import { __clearMockAgents, __installMockAgents } from "../helpers/mock-agents-module.js";
import { createTempStateDir, type TempStateDir } from "../helpers/temp-state-dir.js";

vi.mock("../../agents.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents.js")>("../../agents.js");
  const mod = await import("../helpers/mock-agents-module.js");
  return { ...actual, ObservationAgents: mod.ObservationAgents };
});

// OM_* env vars flow through loadConfig() as the highest-precedence source.
// A shell with OM_OBSERVATION_PROVIDER / OM_OBSERVATION_MODEL (etc.) set will
// override the expected defaults, causing assertions like
// `expect(parsed.observationModel).toContain("google/")` to fail. Save, clear,
// and restore them around every test in this file — same pattern used by
// src/__tests__/unit/config.test.ts.
const OM_ENV_KEYS = [
  "OM_OBSERVATION_MESSAGE_TOKENS",
  "OM_REFLECTION_OBSERVATION_TOKENS",
  "OM_OBSERVATION_PROVIDER",
  "OM_OBSERVATION_MODEL",
  "OM_REFLECTION_PROVIDER",
  "OM_REFLECTION_MODEL",
  "OM_OBSERVATION_TEMPERATURE",
  "OM_REFLECTION_TEMPERATURE",
  "OM_DEBUG",
];

describe("extension: om_status tool", () => {
  let temp: TempStateDir;
  const sessionId = "test-status";
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
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

  it("returns JSON with expected shape", async () => {
    preloadState({
      observations: "* 🔴 test obs",
      observationTokens: 42,
      currentTask: "task-1",
      suggestedResponse: "resp-1",
      lastCycleAt: 1_700_000_000_000,
      lastCycleReason: "turn_end",
    });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = await harness.invokeTool("om_status", {}, ctx);
    const contentText = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(contentText);

    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.observationTokens).toBe(42);
    expect(parsed.currentTask).toBe("task-1");
    expect(parsed.suggestedResponse).toBe("resp-1");
    expect(parsed.observationsPresent).toBe(true);
    expect(parsed.lastCycleReason).toBe("turn_end");
    expect(parsed.lastCycleAt).toBe("2023-11-14T22:13:20.000Z"); // ISO of 1_700_000_000_000
    expect(parsed.observationModel).toContain("google/");
  });

  it("session_id param overrides the default", async () => {
    preloadState({ observations: "" });
    const otherSessionId = "other-session";
    const stateDir = `${temp.stateDir}/.pi/om-state`;
    writeFileSync(
      sessionStatePath(stateDir, otherSessionId),
      JSON.stringify({
        sessionId: otherSessionId,
        observations: "* 🔴 other",
        observationTokens: 5,
        updatedAt: Date.now(),
      }),
    );

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = await harness.invokeTool("om_status", { session_id: otherSessionId }, ctx);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.sessionId).toBe(otherSessionId);
    expect(parsed.observationTokens).toBe(5);
  });

  it("reports observationsPresent=false for empty state", async () => {
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = await harness.invokeTool("om_status", {}, ctx);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.observationsPresent).toBe(false);
    expect(parsed.observationTokens).toBe(0);
  });
});
