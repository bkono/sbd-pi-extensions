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
});
