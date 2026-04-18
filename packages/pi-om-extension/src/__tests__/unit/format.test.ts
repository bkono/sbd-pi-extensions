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
      stagingThreshold: 70000,
      publishThreshold: 90000,
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
      unpublishedMessages: 4,
      unpublishedMessageTokens: 333,
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
    expect(text).toContain("Publish trigger: 90,000 staged-but-unpublished message tokens");
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
});
