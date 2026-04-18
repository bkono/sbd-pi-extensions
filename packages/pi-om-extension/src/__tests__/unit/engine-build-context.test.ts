import { describe, expect, it } from "vitest";
import { buildContinuationReminder, buildObservationContext } from "../../engine.js";
import { OBSERVATION_CONTEXT_INSTRUCTIONS, OBSERVATION_CONTEXT_PROMPT } from "../../prompts.js";
import type { SessionState } from "../../types.js";

function state(partial: Partial<SessionState>): SessionState {
  const observations = partial.observations ?? "";
  const observationTokens = partial.observationTokens ?? 0;

  return {
    sessionId: "s",
    observations,
    observationEntries: partial.observationEntries,
    observationTokens,
    draftObservations: partial.draftObservations ?? observations,
    draftObservationEntries: partial.draftObservationEntries ?? partial.observationEntries,
    draftObservationTokens: partial.draftObservationTokens ?? observationTokens,
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

  it("uses published observations instead of staged draft observations", () => {
    expect(
      buildObservationContext(
        state({
          observations: "",
          draftObservations: "* staged-only",
          draftObservationTokens: 10,
        }),
      ),
    ).toBeUndefined();
  });

  it("renders published observation entries when the stored string is empty", () => {
    const result = buildObservationContext(
      state({
        observations: "",
        observationEntries: [
          {
            date: "2026-04-18",
            line: "* 🔴 (21:13) User plans to revisit reflection robustness tomorrow.",
            temporalAnchors: [
              {
                recordedAt: "2026-04-18T21:13:00.000Z",
                originalPhrase: "tomorrow",
                referencedStart: "2026-04-19",
                precision: "day",
                relation: "future",
              },
            ],
          },
        ],
        draftObservationEntries: [
          {
            date: "2026-04-19",
            line: "* 🟡 staged only",
          },
        ],
      }),
    );

    expect(result).toContain("Date: Apr 18, 2026");
    expect(result).toContain("tomorrow (target: 2026-04-19)");
    expect(result).not.toContain("staged only");
  });

  it("wraps observations in deterministic durable, active, and guidance segments", () => {
    const result = buildObservationContext(state({ observations: "* 🔴 content" }));
    expect(result).toBeDefined();
    expect(result).toContain("<observational-memory>");
    expect(result).toContain("<om-durable>");
    expect(result).toContain("<observations>");
    expect(result).toContain("* 🔴 content");
    expect(result).toContain("</observations>");
    expect(result).toContain("<om-active>");
    expect(result).toContain("<om-guidance>");
    expect(result).toContain("<system-reminder>");
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

  it("includes durable, active, and guidance sections in expected order", () => {
    const result = buildObservationContext(
      state({
        observations: "* obs",
        currentTask: "task",
        suggestedResponse: "resp",
      }),
    )!;
    const contextPromptIdx = result.indexOf(OBSERVATION_CONTEXT_PROMPT);
    const durableIdx = result.indexOf("<om-durable>");
    const obsIdx = result.indexOf("<observations>");
    const activeIdx = result.indexOf("<om-active>");
    const taskIdx = result.indexOf("<current-task>");
    const respIdx = result.indexOf("<suggested-response>");
    const guidanceIdx = result.indexOf("<om-guidance>");
    const instructionsIdx = result.indexOf(OBSERVATION_CONTEXT_INSTRUCTIONS);
    const reminderIdx = result.indexOf("<system-reminder>");
    expect(contextPromptIdx).toBeGreaterThanOrEqual(0);
    expect(durableIdx).toBeGreaterThan(contextPromptIdx);
    expect(obsIdx).toBeGreaterThan(durableIdx);
    expect(activeIdx).toBeGreaterThan(obsIdx);
    expect(taskIdx).toBeGreaterThan(activeIdx);
    expect(respIdx).toBeGreaterThan(taskIdx);
    expect(guidanceIdx).toBeGreaterThan(respIdx);
    expect(instructionsIdx).toBeGreaterThan(guidanceIdx);
    expect(reminderIdx).toBeGreaterThan(instructionsIdx);
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
