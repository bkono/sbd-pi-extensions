import { describe, expect, it } from "vitest";
import { parseObserverOutput } from "../../agents.js";

describe("parseObserverOutput", () => {
  it("extracts all three XML tags when present", () => {
    const raw = `
<observations>
* 🔴 User prefers direct answers
* 🟡 Working on feature X
</observations>

<current-task>
Primary: implementing feature X
</current-task>

<suggested-response>
Ask about edge cases
</suggested-response>
`;
    const result = parseObserverOutput(raw);
    expect(result.observations).toContain("🔴 User prefers direct answers");
    expect(result.observations).toContain("🟡 Working on feature X");
    expect(result.currentTask).toBe("Primary: implementing feature X");
    expect(result.suggestedResponse).toBe("Ask about edge cases");
  });

  it("derives structured observation entries with temporal anchors from date-grouped XML", () => {
    const raw = `
<observations>
Date: Apr 18, 2026
* 🔴 (21:13) User plans to revisit reflection robustness tomorrow.
* 🟡 (09:42) Error pattern appears to have started last week.
* 🟢 (09:45) They might revisit Friday.
</observations>`;
    const result = parseObserverOutput(raw);
    expect(result.observationEntries).toHaveLength(3);
    expect(result.observationEntries?.[0]?.temporalAnchors?.[0]).toMatchObject({
      originalPhrase: "tomorrow",
      referencedStart: "2026-04-19",
      relation: "future",
    });
    expect(result.observationEntries?.[1]?.temporalAnchors?.[0]).toMatchObject({
      originalPhrase: "last week",
      referencedStart: "2026-04-06",
      precision: "week",
    });
    expect(result.observationEntries?.[2]?.temporalAnchors).toBeUndefined();
  });

  it("handles only observations tag", () => {
    const raw = `<observations>* 🔴 Single obs</observations>`;
    const result = parseObserverOutput(raw);
    expect(result.observations).toBe("* 🔴 Single obs");
    expect(result.currentTask).toBeUndefined();
    expect(result.suggestedResponse).toBeUndefined();
  });

  it("handles unclosed observations tag via regex fallback", () => {
    const raw = `<observations>
* 🔴 Unclosed content
(no closing tag)`;
    const result = parseObserverOutput(raw);
    expect(result.observations).toContain("🔴 Unclosed content");
    expect(result.observations).toContain("(no closing tag)");
  });

  it("falls back to plain-text pattern matching when no XML tags", () => {
    const raw = `* Observation one
* Observation two

Current task: Debug the login bug
Suggested response: Ask for reproduction steps`;
    const result = parseObserverOutput(raw);
    expect(result.observations).toContain("Observation one");
    expect(result.observations).toContain("Observation two");
    expect(result.observations).not.toContain("Current task:");
    expect(result.currentTask).toBe("Debug the login bug");
    expect(result.suggestedResponse).toBe("Ask for reproduction steps");
  });

  it("handles mixed-case tags via case-insensitive regex", () => {
    const raw = `<Observations>Content here</Observations>
<Current-Task>Task here</Current-Task>`;
    const result = parseObserverOutput(raw);
    expect(result.observations).toBe("Content here");
    expect(result.currentTask).toBe("Task here");
  });

  it("returns empty observations for empty input", () => {
    const result = parseObserverOutput("");
    expect(result.observations).toBe("");
    expect(result.currentTask).toBeUndefined();
    expect(result.suggestedResponse).toBeUndefined();
  });

  it("trims whitespace inside tags", () => {
    const raw = `<observations>

   padded content

</observations>`;
    const result = parseObserverOutput(raw);
    expect(result.observations).toBe("padded content");
  });

  it("preserves raw field for debugging", () => {
    const raw = `some raw output`;
    const result = parseObserverOutput(raw);
    expect(result.raw).toBe("some raw output");
  });

  it("plain-text fallback with only suggested response line", () => {
    const raw = `Observations content here

Suggested response: Wait for confirmation`;
    const result = parseObserverOutput(raw);
    expect(result.observations).toBe("Observations content here");
    expect(result.suggestedResponse).toBe("Wait for confirmation");
    expect(result.currentTask).toBeUndefined();
  });

  it("preserves multiline task and response structure from XML tags", () => {
    const raw = `<observations>
Date: Apr 18, 2026
* 🔴 (09:12) ✅ Preserved 3 exact list items through reflection.
</observations>

<current-task>
Primary:
- Active: keep the 3-item checklist intact
- Blocked: wait for review before closing the ticket
Secondary:
- ✅ Observer-stage specificity upgrade already landed
</current-task>

<suggested-response>
- Confirm the 3 preserved list items
- Ask whether to keep the blocked state visible in follow-up summaries
</suggested-response>`;

    const result = parseObserverOutput(raw);

    expect(result.currentTask).toContain("- Active: keep the 3-item checklist intact");
    expect(result.currentTask).toContain("- Blocked: wait for review before closing the ticket");
    expect(result.currentTask).toContain("- ✅ Observer-stage specificity upgrade already landed");
    expect(result.suggestedResponse).toContain("- Confirm the 3 preserved list items");
    expect(result.suggestedResponse).toContain(
      "- Ask whether to keep the blocked state visible in follow-up summaries",
    );
  });

  it("preserves exact list items, constraints, and rejected alternatives from XML blocks", () => {
    const raw = `<observations>
Date: Apr 18, 2026
* 🔴 (09:10) Compared 3 candidate fixes for packages/pi-om-extension/src/prompts.ts lines 161-170.
* 🟡 (09:11) Kept Option B because it preserved 2 separate constraints for packages/pi-om-extension/src/agents.ts and packages/pi-om-extension/src/engine.ts.
* 🟡 (09:12) Rejected Option A because it merged the command \`npm run test -w @solvedbydev/pi-om-extension -- src/__tests__/integration/observation-cycle-reflection.test.ts\` with \`bw close sbdpi-f51.5.3\` into one vague follow-up.
</observations>

<current-task>
Primary:
- Active: keep the 3 regression examples separate
- Constraint: preserve the exact line range 161-170 and both file paths verbatim
Secondary:
- Rejected: do not replace Option A vs Option B with a generic "best option"
</current-task>

<suggested-response>
1. Confirm Option B remains selected.
2. Mention the 2 preserved constraints and exact count of 3 candidate fixes.
3. State that \`bw close sbdpi-f51.5.3\` waits until the targeted test command passes.
</suggested-response>`;

    const result = parseObserverOutput(raw);

    expect(result.observations).toContain(
      "Compared 3 candidate fixes for packages/pi-om-extension/src/prompts.ts lines 161-170.",
    );
    expect(result.observations).toContain(
      "Kept Option B because it preserved 2 separate constraints for packages/pi-om-extension/src/agents.ts and packages/pi-om-extension/src/engine.ts.",
    );
    expect(result.observations).toContain(
      "Rejected Option A because it merged the command `npm run test -w @solvedbydev/pi-om-extension -- src/__tests__/integration/observation-cycle-reflection.test.ts` with `bw close sbdpi-f51.5.3` into one vague follow-up.",
    );
    expect(result.currentTask).toContain("- Active: keep the 3 regression examples separate");
    expect(result.currentTask).toContain(
      "- Constraint: preserve the exact line range 161-170 and both file paths verbatim",
    );
    expect(result.currentTask).toContain(
      '- Rejected: do not replace Option A vs Option B with a generic "best option"',
    );
    expect(result.suggestedResponse).toContain("1. Confirm Option B remains selected.");
    expect(result.suggestedResponse).toContain(
      "2. Mention the 2 preserved constraints and exact count of 3 candidate fixes.",
    );
    expect(result.suggestedResponse).toContain(
      "3. State that `bw close sbdpi-f51.5.3` waits until the targeted test command passes.",
    );
  });
});
