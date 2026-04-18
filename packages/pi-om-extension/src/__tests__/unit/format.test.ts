import { describe, expect, it } from "vitest";
import { formatObservationsReport, formatStatusReport, type OMStatusReport } from "../../format.js";

describe("formatters", () => {
  it("formats status output for humans", () => {
    const status: OMStatusReport = {
      sessionId: "session-123",
      stateDir: "/tmp/.pi/om-state",
      statePath: "/tmp/.pi/om-state/session-123.json",
      observationTokens: 1234,
      draftObservationTokens: 1500,
      stagingThreshold: 32000,
      stagingMessageCountThreshold: 12,
      stagingToolResultTokenThreshold: 6000,
      publishThreshold: 90000,
      publishMessageCountThreshold: 36,
      publishToolResultTokenThreshold: 18000,
      chunkMessageTokenLimit: 8000,
      chunkMessageLimit: 8,
      observationModel: "google/gemini-2.5-flash",
      reflectionThreshold: 50000,
      reflectionModel: "google/gemini-2.5-flash",
      observationsPresent: true,
      draftObservationsPresent: true,
      lastObservedEntryId: "entry-9",
      lastObservedTimestamp: "2023-11-14T22:13:20.000Z",
      draftLastObservedEntryId: "entry-12",
      draftLastObservedTimestamp: "2023-11-14T22:16:20.000Z",
      cursorModeForCurrentWindow: "id",
      unpublishedCursorModeForCurrentWindow: "id",
      unobservedMessages: 2,
      unobservedMessageTokens: 99,
      unobservedToolResultCount: 1,
      unobservedToolResultTokens: 88,
      unpublishedMessages: 4,
      unpublishedMessageTokens: 333,
      unpublishedToolResultCount: 2,
      unpublishedToolResultTokens: 222,
      nextChunkMessages: 2,
      nextChunkMessageTokens: 99,
      nextChunkToolResultCount: 1,
      nextChunkToolResultTokens: 88,
      stagingReasons: ["messageCount"],
      publishReasons: ["toolResultTokens"],
      lastCycleAt: "2023-11-14T22:13:20.000Z",
      lastCycleReason: "turn_end",
      lastCursorMode: "id",
      observeTriggered: true,
      publishTriggered: false,
      reflectTriggered: false,
      tailEntriesBeforePrune: 12,
      tailTokensBeforePrune: 300,
      tailEntriesAfterPrune: 4,
      tailTokensAfterPrune: 120,
      prunedEntriesCount: 8,
      currentTask: "Ship the command",
      suggestedResponse: "Call out the slash command.",
      updatedAt: "2023-11-14T22:15:00.000Z",
    };

    const text = formatStatusReport(status);

    expect(text).toContain("Observational memory status · session-123");
    expect(text).toContain("Published observations: yes · 1,234 tokens");
    expect(text).toContain("Staged draft: yes · 1,500 tokens");
    expect(text).toContain(
      "Staging trigger: 32,000 tokens / 12 messages / 6,000 tool-result tokens",
    );
    expect(text).toContain(
      "Publish trigger: 90,000 tokens / 36 messages / 18,000 tool-result tokens",
    );
    expect(text).toContain(
      "Unobserved window: 2 messages · 99 tokens · 1 tool results / 88 tokens · cursor id · triggers message count",
    );
    expect(text).toContain("Next chunk: 2 messages · 99 tokens · 1 tool results / 88 tokens");
    expect(text).toContain("Staged through: entry entry-12 · 2023-11-14 22:16:20 UTC");
    expect(text).toContain("Cycle decisions: stage yes · publish no · reflect no");
    expect(text).toContain("Last cycle: turn_end · 2023-11-14 22:13:20 UTC");
    expect(text).toContain("Last prune: 12 → 4 messages · 8 pruned · 300 → 120 tokens");
    expect(text).toContain("Current task:");
    expect(text).not.toContain('"sessionId"');
  });

  it("formats observation output without XML wrappers", () => {
    const text = formatObservationsReport({
      sessionId: "session-123",
      observations: "* 🔴 user wants OM status\n* 🟡 formatting should be readable",
      observationTokens: 88,
      currentTask: "Inspect OM",
      suggestedResponse: "Summarize the observations.",
      draftObservations: "* 🔴 user wants OM status\n* 🟡 formatting should be readable",
      draftObservationTokens: 88,
      updatedAt: 1_700_000_100_000,
    });

    expect(text).toContain("Observational memory observations · session-123");
    expect(text).toContain("Stored observation tokens: 88");
    expect(text).toContain("Observations:");
    expect(text).toContain("🔴 user wants OM status");
    expect(text).not.toContain("<observations>");
  });

  it("renders structured observation entries with durable temporal anchors", () => {
    const entries = [
      {
        date: "2026-04-18",
        line: "* 🔴 (21:13) User plans to revisit reflection robustness tomorrow.",
        temporalAnchors: [
          {
            recordedAt: "2026-04-18T21:13:00.000Z",
            originalPhrase: "tomorrow",
            referencedStart: "2026-04-19",
            precision: "day" as const,
            relation: "future" as const,
          },
        ],
      },
      {
        date: "2026-04-18",
        line: "* 🟡 (09:42) Error pattern appears to have started last week.",
        temporalAnchors: [
          {
            recordedAt: "2026-04-18T09:42:00.000Z",
            originalPhrase: "last week",
            referencedStart: "2026-04-06",
            precision: "week" as const,
            relation: "past" as const,
          },
        ],
      },
    ];

    const text = formatObservationsReport({
      sessionId: "session-structured",
      observations: "",
      observationEntries: entries,
      observationTokens: 88,
      draftObservations: "",
      draftObservationEntries: entries,
      draftObservationTokens: 88,
      updatedAt: 1_700_000_100_000,
    });

    expect(text).toContain("Date: Apr 18, 2026");
    expect(text).toContain("tomorrow (target: 2026-04-19)");
    expect(text).toContain("last week (week of 2026-04-06)");
  });

  it("renders multi-day anchors so future plans and later state changes stay chronologically readable", () => {
    const entries = [
      {
        date: "2026-04-18",
        line: "* 🔴 (09:00) User plans to resume tomorrow.",
        temporalAnchors: [
          {
            recordedAt: "2026-04-18T09:00:00.000Z",
            originalPhrase: "tomorrow",
            referencedStart: "2026-04-19",
            precision: "day" as const,
            relation: "future" as const,
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
            precision: "day" as const,
            relation: "past" as const,
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
            precision: "day" as const,
            relation: "future" as const,
          },
        ],
      },
      {
        date: "2026-04-21",
        line: "* 🟡 (10:17) They may revisit Friday.",
      },
      {
        date: "2026-04-25",
        line: "* 🟢 (08:30) Rollout landed yesterday as planned.",
        temporalAnchors: [
          {
            recordedAt: "2026-04-25T08:30:00.000Z",
            originalPhrase: "yesterday",
            referencedStart: "2026-04-24",
            precision: "day" as const,
            relation: "past" as const,
          },
        ],
      },
    ];

    const text = formatObservationsReport({
      sessionId: "session-multi-day",
      observations: "",
      observationEntries: entries,
      observationTokens: 144,
      draftObservations: "",
      draftObservationEntries: entries,
      draftObservationTokens: 144,
      updatedAt: 1_700_000_100_000,
    });

    expect(text).toContain("Date: Apr 18, 2026");
    expect(text).toContain("Date: Apr 21, 2026");
    expect(text).toContain("Date: Apr 25, 2026");
    expect(text).toContain("tomorrow (target: 2026-04-19)");
    expect(text).toContain("yesterday (date: 2026-04-20)");
    expect(text).toContain("next Friday (target: 2026-04-24)");
    expect(text).toContain("They may revisit Friday.");
    expect(text).toContain("yesterday (date: 2026-04-24)");

    const apr18 = text.indexOf("Date: Apr 18, 2026");
    const apr21 = text.indexOf("Date: Apr 21, 2026");
    const apr25 = text.indexOf("Date: Apr 25, 2026");
    expect(apr18).toBeGreaterThanOrEqual(0);
    expect(apr21).toBeGreaterThan(apr18);
    expect(apr25).toBeGreaterThan(apr21);
  });
});
