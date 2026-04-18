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
    expect(result).toContain("<om-current-task>");
    expect(result).toContain("<om-suggested-response>");
    expect(result).toContain("<om-guidance>");
    expect(result).toContain("<system-reminder>");
  });

  it("keeps empty active subsegments even when no task state is stored", () => {
    const result = buildObservationContext(state({ observations: "* obs" }))!;
    expect(result).toContain(
      "<om-current-task>\n<current-task>\n</current-task>\n</om-current-task>",
    );
    expect(result).toContain(
      "<om-suggested-response>\n<suggested-response>\n</suggested-response>\n</om-suggested-response>",
    );
  });
  it("includes current-task section when set", () => {
    const result = buildObservationContext(
      state({ observations: "* obs", currentTask: "Do the thing" }),
    )!;
    expect(result).toContain("<om-current-task>");
    expect(result).toContain("<current-task>");
    expect(result).toContain("Do the thing");
    expect(result).toContain("</current-task>");
  });
  it("includes suggested-response section when set", () => {
    const result = buildObservationContext(
      state({ observations: "* obs", suggestedResponse: "Ask about X" }),
    )!;
    expect(result).toContain("<om-suggested-response>");
    expect(result).toContain("<suggested-response>");
    expect(result).toContain("Ask about X");
    expect(result).toContain("</suggested-response>");
  });

  it("normalizes legacy line endings and trailing whitespace inside sections", () => {
    const result = buildObservationContext(
      state({
        observations: "Date: Apr 18, 2026\r\n* 🔴 content   \r\n",
        currentTask: "  Keep working\r\n- step 1   \r\n",
        suggestedResponse: "  Mention the next step.   ",
      }),
    )!;

    expect(result).not.toContain("\r");
    expect(result).toContain("Date: Apr 18, 2026\n* 🔴 content");
    expect(result).toContain("<current-task>\nKeep working\n- step 1\n</current-task>");
    expect(result).toContain("<suggested-response>\nMention the next step.\n</suggested-response>");
  });

  it("keeps the durable segment byte-stable when only active task state changes", () => {
    const first = buildObservationContext(
      state({ observations: "* obs", currentTask: "First task" }),
    )!;
    const second = buildObservationContext(
      state({ observations: "* obs", currentTask: "Second task" }),
    )!;

    const durableStart = first.indexOf("<om-durable>");
    const durableEnd = first.indexOf("</om-durable>") + "</om-durable>".length;
    const secondDurableStart = second.indexOf("<om-durable>");
    const secondDurableEnd = second.indexOf("</om-durable>") + "</om-durable>".length;

    expect(first.slice(durableStart, durableEnd)).toBe(
      second.slice(secondDurableStart, secondDurableEnd),
    );
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
    const currentSegmentIdx = result.indexOf("<om-current-task>");
    const taskIdx = result.indexOf("<current-task>");
    const suggestedSegmentIdx = result.indexOf("<om-suggested-response>");
    const respIdx = result.indexOf("<suggested-response>");
    const guidanceIdx = result.indexOf("<om-guidance>");
    const instructionsIdx = result.indexOf(OBSERVATION_CONTEXT_INSTRUCTIONS);
    const reminderIdx = result.indexOf("<system-reminder>");
    expect(contextPromptIdx).toBeGreaterThanOrEqual(0);
    expect(durableIdx).toBeGreaterThan(contextPromptIdx);
    expect(obsIdx).toBeGreaterThan(durableIdx);
    expect(activeIdx).toBeGreaterThan(obsIdx);
    expect(currentSegmentIdx).toBeGreaterThan(activeIdx);
    expect(taskIdx).toBeGreaterThan(currentSegmentIdx);
    expect(suggestedSegmentIdx).toBeGreaterThan(taskIdx);
    expect(respIdx).toBeGreaterThan(suggestedSegmentIdx);
    expect(guidanceIdx).toBeGreaterThan(respIdx);
    expect(instructionsIdx).toBeGreaterThan(guidanceIdx);
    expect(reminderIdx).toBeGreaterThan(instructionsIdx);
  });

  it("preserves anchored multi-day chronology in the published observation context", () => {
    const result = buildObservationContext(
      state({
        observations: "",
        observationEntries: [
          {
            date: "2026-04-18",
            line: "* 🔴 (09:00) User plans to resume tomorrow.",
            temporalAnchors: [
              {
                recordedAt: "2026-04-18T09:00:00.000Z",
                originalPhrase: "tomorrow",
                referencedStart: "2026-04-19",
                precision: "day",
                relation: "future",
              },
            ],
          },
          {
            date: "2026-04-21",
            line: "* 🟡 (10:15) User resumed work yesterday after a multi-day gap.",
            temporalAnchors: [
              {
                recordedAt: "2026-04-21T10:15:00.000Z",
                originalPhrase: "yesterday",
                referencedStart: "2026-04-20",
                precision: "day",
                relation: "past",
              },
            ],
          },
          {
            date: "2026-04-21",
            line: "* 🟡 (10:16) Rollout now shifts next Friday.",
            temporalAnchors: [
              {
                recordedAt: "2026-04-21T10:16:00.000Z",
                originalPhrase: "next Friday",
                referencedStart: "2026-04-24",
                precision: "day",
                relation: "future",
              },
            ],
          },
          {
            date: "2026-04-25",
            line: "* 🟢 (08:30) Rollout landed yesterday as planned.",
            temporalAnchors: [
              {
                recordedAt: "2026-04-25T08:30:00.000Z",
                originalPhrase: "yesterday",
                referencedStart: "2026-04-24",
                precision: "day",
                relation: "past",
              },
            ],
          },
        ],
        draftObservationEntries: [
          {
            date: "2026-04-26",
            line: "* 🟡 staged only",
          },
        ],
      }),
    );

    expect(result).toContain("Date: Apr 18, 2026");
    expect(result).toContain("Date: Apr 21, 2026");
    expect(result).toContain("Date: Apr 25, 2026");
    expect(result).toContain("tomorrow (target: 2026-04-19)");
    expect(result).toContain("yesterday (date: 2026-04-20)");
    expect(result).toContain("next Friday (target: 2026-04-24)");
    expect(result).toContain("yesterday (date: 2026-04-24)");
    expect(result).not.toContain("staged only");

    const apr18 = result.indexOf("Date: Apr 18, 2026");
    const apr21 = result.indexOf("Date: Apr 21, 2026");
    const apr25 = result.indexOf("Date: Apr 25, 2026");
    expect(apr18).toBeGreaterThanOrEqual(0);
    expect(apr21).toBeGreaterThan(apr18);
    expect(apr25).toBeGreaterThan(apr21);
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
