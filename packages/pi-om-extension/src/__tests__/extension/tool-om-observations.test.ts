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

describe("extension: om_observations tool", () => {
  let temp: TempStateDir;
  const sessionId = "test-observations";

  beforeEach(() => {
    temp = createTempStateDir();
    __installMockAgents(new MockObservationAgents());
  });

  afterEach(() => {
    __clearMockAgents();
    temp.cleanup();
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

  it("returns '(no observations stored)' for empty state", async () => {
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = await harness.invokeTool("om_observations", {}, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("(no observations stored)");
  });

  it("returns XML-wrapped observations block when present", async () => {
    preloadState({
      observations: "* 🔴 user likes X\n* 🟡 working on Y",
    });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = await harness.invokeTool("om_observations", {}, ctx);
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain(`<session>${sessionId}</session>`);
    expect(text).toContain("<observational-memory>");
    expect(text).toContain("<om-durable>");
    expect(text).toContain("<observations>");
    expect(text).toContain("🔴 user likes X");
    expect(text).toContain("🟡 working on Y");
    expect(text).toContain("</observations>");
    expect(text).toContain("<om-active>");
  });

  it("includes current-task and suggested-response sections when set", async () => {
    preloadState({
      observations: "* obs",
      currentTask: "Finish the feature",
      suggestedResponse: "Ask about tests",
    });

    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = await harness.invokeTool("om_observations", {}, ctx);
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("<current-task>");
    expect(text).toContain("Finish the feature");
    expect(text).toContain("<suggested-response>");
    expect(text).toContain("<om-active>");
    expect(text).toContain("Ask about tests");
  });
});
