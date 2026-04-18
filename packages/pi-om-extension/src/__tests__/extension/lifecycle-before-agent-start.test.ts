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
    draftObservations?: string;
    draftObservationTokens?: number;
    draftCurrentTask?: string;
    draftSuggestedResponse?: string;
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
        draftObservations: state.draftObservations,
        draftObservationTokens: state.draftObservationTokens,
        draftCurrentTask: state.draftCurrentTask,
        draftSuggestedResponse: state.draftSuggestedResponse,
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
    expect(result!.systemPrompt).toContain("<om-current-task>");
    expect(result!.systemPrompt).toContain("<om-suggested-response>");
    expect(result!.systemPrompt).toContain("🔴 user likes X");
    expect(result!.systemPrompt).toContain("<om-guidance>");
    expect(result!.systemPrompt).toContain("<system-reminder>");
  });

  it("injects only the published snapshot when draft state is ahead", async () => {
    preloadState({
      observations: "* 🔴 published snapshot",
      observationTokens: 20,
      currentTask: "Published task",
      suggestedResponse: "Published response",
      draftObservations: "* 🟡 staged draft only",
      draftObservationTokens: 40,
      draftCurrentTask: "Draft task",
      draftSuggestedResponse: "Draft response",
    });
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "continue", systemPrompt: "Base prompt" },
      ctx,
    )) as { systemPrompt: string };

    expect(result.systemPrompt).toContain("published snapshot");
    expect(result.systemPrompt).toContain("Published task");
    expect(result.systemPrompt).toContain("Published response");
    expect(result.systemPrompt).not.toContain("staged draft only");
    expect(result.systemPrompt).not.toContain("Draft task");
    expect(result.systemPrompt).not.toContain("Draft response");
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
    expect(result.systemPrompt).toContain("<om-current-task>");
    expect(result.systemPrompt).toContain("Fix bug X");
    expect(result.systemPrompt).toContain("<suggested-response>");
    expect(result.systemPrompt).toContain("<om-suggested-response>");
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
