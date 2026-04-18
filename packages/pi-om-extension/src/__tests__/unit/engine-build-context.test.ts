import { describe, expect, it } from "vitest";
import {
  buildContinuationReminder,
  buildObservationContext,
  buildStoredObservationBlock,
  buildStoredObservationSegments,
} from "../../engine.js";
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

function extractTagBlock(source: string, tag: string): string {
  const startTag = `<${tag}>`;
  const endTag = `</${tag}>`;
  const start = source.indexOf(startTag);
  const end = source.indexOf(endTag);

  if (start < 0 || end < start) {
    throw new Error(`Missing <${tag}> block in test fixture`);
  }

  return source.slice(start, end + endTag.length);
}

function extractObservationPrefixBeforeGuidance(source: string): string {
  const start = source.indexOf("<observational-memory>");
  const guidance = source.indexOf("\n\n<om-guidance>");

  if (start < 0 || guidance < start) {
    throw new Error("Missing observational-memory guidance boundary in test fixture");
  }

  return source.slice(start, guidance);
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

  it("preserves the future segmented layout inside the single-string fallback prefix", () => {
    const published = state({
      observations: `Date: Apr 18, 2026
* 🔴 Durable preference: keep cache-friendly prompt prefixes stable.

Date: Apr 19, 2026
* 🟡 Tooling note: later active-state updates should stay localized.`,
      currentTask: `Primary:
- Verify the active task segment changes without rewriting durable memory.
Secondary:
- Keep the fallback layout ready for future multi-message injection.`,
      suggestedResponse:
        "Confirm the durable history is stable, then explain that only the active segment changed.",
    });
    const segments = buildStoredObservationSegments(published);
    const storedBlock = buildStoredObservationBlock(published);
    const context = buildObservationContext(published);

    expect(segments).toBeDefined();
    expect(storedBlock).toBeDefined();
    expect(context).toBeDefined();

    const prefix = extractObservationPrefixBeforeGuidance(context!);
    expect(prefix).toMatchInlineSnapshot(`
      "<observational-memory>
      <om-durable>
      <observations>
      Date: Apr 18, 2026
      * 🔴 Durable preference: keep cache-friendly prompt prefixes stable.
      
      Date: Apr 19, 2026
      * 🟡 Tooling note: later active-state updates should stay localized.
      </observations>
      </om-durable>
      
      <om-active>
      <om-current-task>
      <current-task>
      Primary:
      - Verify the active task segment changes without rewriting durable memory.
      Secondary:
      - Keep the fallback layout ready for future multi-message injection.
      </current-task>
      </om-current-task>
      
      <om-suggested-response>
      <suggested-response>
      Confirm the durable history is stable, then explain that only the active segment changed.
      </suggested-response>
      </om-suggested-response>
      </om-active>"
    `);
    expect(prefix).toBe(["<observational-memory>", ...segments!].join("\n"));
    expect(storedBlock).toBe(`${prefix}\n</observational-memory>`);
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

  it("localizes diffs to the active task block when durable and guidance content are unchanged", () => {
    const first = buildObservationContext(
      state({
        observations: "Date: Apr 18, 2026\n* 🔴 durable history",
        currentTask: "Primary:\n- First active task",
        suggestedResponse: "Keep the same suggested response.",
      }),
    )!;
    const second = buildObservationContext(
      state({
        observations: "Date: Apr 18, 2026\n* 🔴 durable history",
        currentTask: "Primary:\n- Second active task",
        suggestedResponse: "Keep the same suggested response.",
      }),
    )!;

    expect(first).not.toBe(second);
    expect(extractTagBlock(first, "om-durable")).toBe(extractTagBlock(second, "om-durable"));
    expect(extractTagBlock(first, "om-suggested-response")).toBe(
      extractTagBlock(second, "om-suggested-response"),
    );
    expect(extractTagBlock(first, "om-guidance")).toBe(extractTagBlock(second, "om-guidance"));
    expect(extractTagBlock(first, "om-current-task")).not.toBe(
      extractTagBlock(second, "om-current-task"),
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
  it("prefers published completion-state snapshots over draft reactivation", () => {
    const result = buildObservationContext(
      state({
        observations: "",
        observationEntries: [
          {
            date: "2026-04-18",
            line: "* 🔴 (09:10) ✅ Finished the completion-marker parser and saved regression fixtures.",
          },
          {
            date: "2026-04-18",
            line: "* 🟢 (09:11) Resolved blocker: sbdpi-f51.2.3 temporal regressions landed.",
          },
          {
            date: "2026-04-18",
            line: "* ⚪ (09:12) Superseded the manual blocker reminder path with durable lifecycle rendering.",
          },
          {
            date: "2026-04-18",
            line: "* ⚪ (09:13) Abandoned the active-summary rewrite experiment after it revived completed work.",
          },
        ],
        currentTask: `Primary:
- Active: Land sbdpi-f51.1.3 by running targeted validation and committing the regression coverage.
- ✅ Completed: Completion-marker parser and durable rendering already landed.
Secondary:
- Resolved blocker: sbdpi-f51.2.3 temporal regressions landed, so no active wait remains.
- Superseded: manual blocker reminder path replaced by durable lifecycle rendering.
- Abandoned: active-summary rewrite experiment after it revived completed work.`,
        suggestedResponse: "Summarize the remaining active step without reopening completed work.",
        draftObservations:
          "Date: Apr 18, 2026\n* 🔴 (09:20) Active again: redo the completion-marker parser from scratch.",
        draftObservationEntries: [
          {
            date: "2026-04-18",
            line: "* 🔴 (09:20) Active again: redo the completion-marker parser from scratch.",
          },
        ],
        draftObservationTokens: 999,
        draftCurrentTask: `Primary:
- Active: Redo the completion-marker parser from scratch.`,
        draftSuggestedResponse: "Tell the user the already-finished parser work is active again.",
      }),
    )!;

    expect(result).toContain(
      "✅ Finished the completion-marker parser and saved regression fixtures.",
    );
    expect(result).toContain("Resolved blocker: sbdpi-f51.2.3 temporal regressions landed.");
    expect(result).toContain(
      "Superseded the manual blocker reminder path with durable lifecycle rendering.",
    );
    expect(result).toContain(
      "Abandoned the active-summary rewrite experiment after it revived completed work.",
    );
    expect(result).toContain(
      "- ✅ Completed: Completion-marker parser and durable rendering already landed.",
    );
    expect(result).toContain(
      "- Resolved blocker: sbdpi-f51.2.3 temporal regressions landed, so no active wait remains.",
    );
    expect(result).toContain(
      "Summarize the remaining active step without reopening completed work.",
    );
    expect(result).not.toContain("Active again: redo the completion-marker parser from scratch.");
    expect(result).not.toContain("Tell the user the already-finished parser work is active again.");
  });
  it("keeps item distinctions, exact numbers, and constraints recoverable in the injected OM block", () => {
    const result = buildObservationContext(
      state({
        observations: "",
        observationEntries: [
          {
            date: "2026-04-18",
            line: "* 🔴 (09:10) Compared 3 candidate fixes for packages/pi-om-extension/src/prompts.ts lines 161-170.",
          },
          {
            date: "2026-04-18",
            line: "* 🟡 (09:11) Kept Option B because it preserved 2 constraints separately: packages/pi-om-extension/src/agents.ts stays distinct from packages/pi-om-extension/src/engine.ts, and the exact count 3 remains attached to the checklist.",
          },
          {
            date: "2026-04-18",
            line: "* 🟡 (09:12) Rejected Option A and deferred `bw close sbdpi-f51.5.3` until `npm run test -w @solvedbydev/pi-om-extension -- src/__tests__/integration/observation-cycle-reflection.test.ts` passes.",
          },
        ],
        currentTask: [
          "Primary:",
          "- Active: keep the 3 regression examples separate",
          "- Constraint: preserve line range 161-170 and both file paths verbatim",
          "Secondary:",
          "- Rejected: do not flatten Option A and Option B into one generic fix",
        ].join("\n"),
        suggestedResponse: [
          "1. Confirm Option B remains selected.",
          "2. Mention the 2 preserved constraints and exact count of 3.",
          "3. Say that `bw close sbdpi-f51.5.3` waits for the targeted test command.",
        ].join("\n"),
      }),
    )!;
    expect(result).toContain("Date: Apr 18, 2026");
    expect(result).toContain(
      "Compared 3 candidate fixes for packages/pi-om-extension/src/prompts.ts lines 161-170.",
    );
    expect(result).toContain(
      "Kept Option B because it preserved 2 constraints separately: packages/pi-om-extension/src/agents.ts stays distinct from packages/pi-om-extension/src/engine.ts, and the exact count 3 remains attached to the checklist.",
    );
    expect(result).toContain(
      "Rejected Option A and deferred `bw close sbdpi-f51.5.3` until `npm run test -w @solvedbydev/pi-om-extension -- src/__tests__/integration/observation-cycle-reflection.test.ts` passes.",
    );
    expect(result).toContain("- Active: keep the 3 regression examples separate");
    expect(result).toContain(
      "- Constraint: preserve line range 161-170 and both file paths verbatim",
    );
    expect(result).toContain(
      "- Rejected: do not flatten Option A and Option B into one generic fix",
    );
    expect(result).toContain("1. Confirm Option B remains selected.");
    expect(result).toContain("2. Mention the 2 preserved constraints and exact count of 3.");
    expect(result).toContain(
      "3. Say that `bw close sbdpi-f51.5.3` waits for the targeted test command.",
    );
    const optionBIndex = result.indexOf(
      "Kept Option B because it preserved 2 constraints separately",
    );
    const optionAIndex = result.indexOf("Rejected Option A and deferred `bw close sbdpi-f51.5.3`");
    expect(optionBIndex).toBeGreaterThanOrEqual(0);
    expect(optionAIndex).toBeGreaterThan(optionBIndex);
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
