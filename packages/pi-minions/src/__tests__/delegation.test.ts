import { describe, expect, it } from "vitest";
import {
  buildPromptFromContext,
  createDelegationHint,
  isComplexDelegationTask,
  shouldInjectDelegationHint,
} from "../delegation.js";

const delegationConfig = {
  toolCallThreshold: 16,
  promptLengthThreshold: 4_000,
  hintIntervalMinutes: 8,
  acknowledgementRequired: false,
  complexTaskKeywords: ["audit", "refactor"],
};

describe("delegation hint", () => {
  it("uses non-blocking delegation reminder wording by default", () => {
    const hint = createDelegationHint(17, { acknowledgementRequired: false });

    expect(hint).toContain("DELEGATION REMINDER: You have made 17 tool calls");
    expect(hint).toContain("pi-minions extension is active");
    expect(hint).toContain("`spawn` tool");
    expect(hint).toContain("pass a `tasks` array to `spawn`");
    expect(hint).not.toContain("spawn_bg");
    expect(hint).not.toContain("ALWAYS acknowledge this reminder");
    expect(hint.toLowerCase()).not.toContain("acknowledge");
  });

  it("does not add acknowledgement instructions to custom messages", () => {
    const hint = createDelegationHint(8, {
      acknowledgementRequired: true,
      message: "You are at {toolCallCount}; split the work.",
    });

    expect(hint).toBe("You are at 8; split the work.");
  });

  it("supports custom message templates", () => {
    const hint = createDelegationHint(5, {
      acknowledgementRequired: false,
      message: "You are at {toolCallCount}; split the work.",
    });

    expect(hint).toBe("You are at 5; split the work.");
  });
});

describe("delegation complexity detection", () => {
  it("triggers when the tool-call threshold is reached", () => {
    expect(
      isComplexDelegationTask({
        toolCallCount: 16,
        prompt: "small task",
        config: delegationConfig,
      }),
    ).toBe(true);
  });

  it("triggers on complex-task keywords", () => {
    expect(
      isComplexDelegationTask({
        toolCallCount: 0,
        prompt: "Please audit this module.",
        config: delegationConfig,
      }),
    ).toBe(true);
  });

  it("does not trigger for simple short prompts", () => {
    expect(
      isComplexDelegationTask({
        toolCallCount: 1,
        prompt: "What time is it?",
        config: delegationConfig,
      }),
    ).toBe(false);
  });
});

describe("delegation injection gating", () => {
  it("injects only when complex, minions are unused, and the interval elapsed", () => {
    expect(
      shouldInjectDelegationHint({
        usedMinionsThisSession: false,
        isComplexTask: true,
        now: 10 * 60_000,
        lastHintTime: 0,
        hintIntervalMinutes: 8,
      }),
    ).toBe(true);
  });

  it("suppresses hints after minions have already been used", () => {
    expect(
      shouldInjectDelegationHint({
        usedMinionsThisSession: true,
        isComplexTask: true,
        now: 10 * 60_000,
        lastHintTime: 0,
        hintIntervalMinutes: 8,
      }),
    ).toBe(false);
  });

  it("extracts only the current user prompt from context messages", () => {
    const prompt = buildPromptFromContext([
      { role: "system", content: "ignore", timestamp: 1 },
      { role: "user", content: "historical long task", timestamp: 2 },
      { role: "assistant", content: "ignored", timestamp: 3 },
      { role: "user", content: "current task", timestamp: 4 },
    ]);

    expect(prompt).toBe("current task");
  });

  it("does not treat historical prompt length as current-task complexity", () => {
    const prompt = buildPromptFromContext([
      { role: "user", content: "audit ".repeat(1_000), timestamp: 1 },
      { role: "assistant", content: "done", timestamp: 2 },
      { role: "user", content: "thanks", timestamp: 3 },
    ]);

    expect(prompt).toBe("thanks");
    expect(isComplexDelegationTask({ toolCallCount: 0, prompt, config: delegationConfig })).toBe(
      false,
    );
  });
});
