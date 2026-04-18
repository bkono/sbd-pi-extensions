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

describe("extension: before_agent_start lifecycle", () => {
  let temp: TempStateDir;
  const sessionId = "test-before-agent-start";

  beforeEach(() => {
    temp = createTempStateDir();
    __installMockAgents(new MockObservationAgents());
  });

  afterEach(() => {
    __clearMockAgents();
    temp.cleanup();
  });

  function preloadState(state: {
    observations?: string;
    currentTask?: string;
    suggestedResponse?: string;
    observationTokens?: number;
  }) {
    const stateDir = `${temp.stateDir}/.pi/om-state`;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      sessionStatePath(stateDir, sessionId),
      JSON.stringify({
        sessionId,
        observations: state.observations ?? "",
        observationTokens: state.observationTokens ?? 0,
        currentTask: state.currentTask,
        suggestedResponse: state.suggestedResponse,
        updatedAt: Date.now(),
      }),
    );
  }

  it("returns undefined when observations are empty", async () => {
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: "You are a helper." },
      ctx,
    );

    expect(result).toBeUndefined();
  });

  it("returns modified systemPrompt when observations exist", async () => {
    preloadState({ observations: "* 🔴 user likes X", observationTokens: 20 });
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: "You are a helper." },
      ctx,
    )) as { systemPrompt: string } | undefined;

    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain("You are a helper.");
    expect(result!.systemPrompt).toContain("<observational-memory>");
    expect(result!.systemPrompt).toContain("<om-durable>");
    expect(result!.systemPrompt).toContain("🔴 user likes X");
    expect(result!.systemPrompt).toContain("<om-guidance>");
    expect(result!.systemPrompt).toContain("<system-reminder>");
  });

  it("includes currentTask and suggestedResponse in the appendix", async () => {
    preloadState({
      observations: "* 🔴 ongoing work",
      currentTask: "Fix bug X",
      suggestedResponse: "Continue from where we left off",
      observationTokens: 20,
    });
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "continue", systemPrompt: "Base prompt" },
      ctx,
    )) as { systemPrompt: string };

    expect(result.systemPrompt).toContain("<current-task>");
    expect(result.systemPrompt).toContain("Fix bug X");
    expect(result.systemPrompt).toContain("<suggested-response>");
    expect(result.systemPrompt).toContain("<om-active>");
    expect(result.systemPrompt).toContain("Continue from where we left off");
  });

  it("preserves original system prompt as prefix", async () => {
    preloadState({ observations: "* 🔴 obs", observationTokens: 20 });
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const originalPrompt = "UNIQUE_ORIGINAL_PREFIX";
    const result = (await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: originalPrompt },
      ctx,
    )) as { systemPrompt: string };

    expect(result.systemPrompt.indexOf(originalPrompt)).toBe(0);
  });
});
