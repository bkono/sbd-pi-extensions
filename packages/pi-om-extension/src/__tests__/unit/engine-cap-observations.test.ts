import { describe, expect, it } from "vitest";
import {
  buildObservationContext,
  capPublishedObservationState,
  OBSERVATION_OMISSION_PREFIX,
  truncateObservationText,
} from "../../engine.js";
import { countTokens } from "../../tokens.js";
import type { SessionState } from "../../types.js";

function state(overrides: Partial<SessionState>): SessionState {
  return {
    sessionId: "cap-test",
    observations: "* observation",
    observationTokens: 2,
    draftObservations: "* observation",
    draftObservationTokens: 2,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("truncateObservationText", () => {
  it("returns small observation text unchanged", () => {
    const observations = "* first\n* second";
    expect(truncateObservationText(observations, 1_000)).toBe(observations);
  });

  it("keeps the newest whole lines with an explicit omission marker", () => {
    const observations = Array.from(
      { length: 30 },
      (_, index) => `* observation-${index} ${`detail-${index} `.repeat(40)}`,
    ).join("\n");

    const result = truncateObservationText(observations, 500);

    expect(countTokens(result)).toBeLessThanOrEqual(500);
    expect(result).toContain(OBSERVATION_OMISSION_PREFIX);
    expect(result).toContain("observation-29");
    expect(result).not.toContain("observation-0 ");
  });

  it("halves a single oversized newest line until the result fits", () => {
    const result = truncateObservationText(`* ${"oversized ".repeat(2_000)}`, 120);

    expect(countTokens(result)).toBeLessThanOrEqual(120);
    expect(result).toContain(OBSERVATION_OMISSION_PREFIX);
  });
});

describe("capPublishedObservationState", () => {
  it("returns the original state when the complete injected context already fits", () => {
    const published = state({ currentTask: "Finish the tests." });
    expect(capPublishedObservationState(published, 4_000)).toBe(published);
  });

  it("drops oldest structured entries first and caps the complete rendered context", () => {
    const observationEntries = Array.from({ length: 30 }, (_, index) => ({
      date: "2026-09-02",
      line: `* structured-${index} ${`detail-${index} `.repeat(45)}`,
    }));
    const published = state({
      observations: "legacy shadow text",
      observationEntries,
      currentTask: "Preserve the current task.",
    });

    const capped = capPublishedObservationState(published, 900);
    const context = buildObservationContext(capped)!;

    expect(capped).not.toBe(published);
    expect(countTokens(context)).toBeLessThanOrEqual(900);
    expect(context).toContain(OBSERVATION_OMISSION_PREFIX);
    expect(context).toContain("structured-29");
    expect(context).not.toContain("structured-0 ");
    expect(context).toContain("Preserve the current task.");
  });

  it("caps legacy text and an oversized current task within the total budget", () => {
    const published = state({
      observations: Array.from(
        { length: 40 },
        (_, index) => `* legacy-${index} ${"history ".repeat(40)}`,
      ).join("\n"),
      currentTask: Array.from(
        { length: 30 },
        (_, index) => `task-${index} ${"detail ".repeat(35)}`,
      ).join("\n"),
    });

    const capped = capPublishedObservationState(published, 1_000);
    const context = buildObservationContext(capped)!;

    expect(countTokens(context)).toBeLessThanOrEqual(1_000);
    expect(context).toContain(OBSERVATION_OMISSION_PREFIX);
    expect(context).toContain("legacy-39");
    expect(context).toContain("task-29");
  });
});
