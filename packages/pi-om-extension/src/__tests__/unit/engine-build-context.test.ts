import { describe, expect, it } from "vitest";
import { buildContinuationReminder, buildObservationContext } from "../../engine.js";
import { OBSERVATION_CONTEXT_INSTRUCTIONS, OBSERVATION_CONTEXT_PROMPT } from "../../prompts.js";
import type { SessionState } from "../../types.js";

function state(partial: Partial<SessionState>): SessionState {
  return {
    sessionId: "s",
    observations: "",
    observationTokens: 0,
    updatedAt: Date.now(),
    ...partial,
  };
}

describe("buildObservationContext", () => {
  it("returns undefined when observations is empty", () => {
    expect(buildObservationContext(state({ observations: "" }))).toBeUndefined();
  });

  it("returns undefined when observations is only whitespace", () => {
    expect(buildObservationContext(state({ observations: "   \n\n  " }))).toBeUndefined();
  });

  it("includes observations block wrapped in XML tags", () => {
    const result = buildObservationContext(state({ observations: "* 🔴 content" }));
    expect(result).toBeDefined();
    expect(result).toContain("<observations>");
    expect(result).toContain("* 🔴 content");
    expect(result).toContain("</observations>");
  });

  it("omits current-task section when not present", () => {
    const result = buildObservationContext(state({ observations: "* obs" }))!;
    expect(result).not.toContain("<current-task>");
  });

  it("omits suggested-response section when not present", () => {
    const result = buildObservationContext(state({ observations: "* obs" }))!;
    expect(result).not.toContain("<suggested-response>");
  });

  it("includes current-task section when set", () => {
    const result = buildObservationContext(
      state({ observations: "* obs", currentTask: "Do the thing" }),
    )!;
    expect(result).toContain("<current-task>");
    expect(result).toContain("Do the thing");
    expect(result).toContain("</current-task>");
  });

  it("includes suggested-response section when set", () => {
    const result = buildObservationContext(
      state({ observations: "* obs", suggestedResponse: "Ask about X" }),
    )!;
    expect(result).toContain("<suggested-response>");
    expect(result).toContain("Ask about X");
    expect(result).toContain("</suggested-response>");
  });

  it("includes all sections in expected order", () => {
    const result = buildObservationContext(
      state({
        observations: "* obs",
        currentTask: "task",
        suggestedResponse: "resp",
      }),
    )!;
    const contextPromptIdx = result.indexOf(OBSERVATION_CONTEXT_PROMPT);
    const obsIdx = result.indexOf("<observations>");
    const taskIdx = result.indexOf("<current-task>");
    const respIdx = result.indexOf("<suggested-response>");
    const instructionsIdx = result.indexOf(OBSERVATION_CONTEXT_INSTRUCTIONS);

    expect(contextPromptIdx).toBeGreaterThanOrEqual(0);
    expect(obsIdx).toBeGreaterThan(contextPromptIdx);
    expect(taskIdx).toBeGreaterThan(obsIdx);
    expect(respIdx).toBeGreaterThan(taskIdx);
    expect(instructionsIdx).toBeGreaterThan(respIdx);
  });
});

describe("buildContinuationReminder", () => {
  it("wraps hint in system-reminder tags", () => {
    const result = buildContinuationReminder();
    expect(result).toMatch(/^<system-reminder>/);
    expect(result).toMatch(/<\/system-reminder>$/);
  });

  it("contains the continuation hint body", () => {
    const result = buildContinuationReminder();
    expect(result).toContain("conversation history grew too long");
  });
});
