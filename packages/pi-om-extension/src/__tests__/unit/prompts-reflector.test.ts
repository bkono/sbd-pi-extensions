import { describe, expect, it } from "vitest";
import { buildReflectorSystemPrompt } from "../../prompts.js";

describe("buildReflectorSystemPrompt", () => {
  it("reinforces preservation of list structure, exact values, and outcome state", () => {
    const prompt = buildReflectorSystemPrompt();

    expect(prompt).toContain("CRITICAL: CONSOLIDATE WITHOUT LOSING STRUCTURE");
    expect(prompt).toContain(
      "Preserve list structure when it carries meaning. If the source had multiple options, steps, files, constraints, outcomes, or rejected alternatives, keep them as separate bullets/observations instead of flattening them into prose.",
    );
    expect(prompt).toContain(
      "Preserve exact numbers, counts, measurements, dates/times, durations, file paths, line numbers, commands, identifiers, versions, and error text when they matter.",
    );
    expect(prompt).toContain(
      "planned, active, blocked, waiting for user, done/✅, rejected, superseded, abandoned",
    );
    expect(prompt).toContain(
      'Never replace exact values with vague approximations like "some", "several", "recently", "a few files", or "later" when the source gave the precise detail.',
    );
  });

  it("requires structured active-state and response guidance blocks", () => {
    const prompt = buildReflectorSystemPrompt();

    expect(prompt).toContain("<current-task>");
    expect(prompt).toContain(
      "If there are multiple active items, keep them itemized on separate lines with status markers instead of flattening them.",
    );
    expect(prompt).toContain(
      'Secondary: pending user-facing tasks, with "waiting for user", blocked, and ✅ completed states flagged when applicable.',
    );
    expect(prompt).toContain("<suggested-response>");
    expect(prompt).toContain(
      "Keep it specific; preserve ordered steps, open questions, constraints, and waiting conditions when they matter.",
    );
  });
});
