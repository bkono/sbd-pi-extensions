import { describe, expect, it, vi } from "vitest";
import { type DoomLoopWarning, formatDoomLoopMessage } from "../src/doom-loop.js";
import { GENERIC_SUGGESTION, SUGGESTIONS } from "../src/doom-loop-suggestions.js";

vi.mock("../src/doom-loop-suggestions.js", () => ({
  GENERIC_SUGGESTION: "GENERIC_SENTINEL",
  SUGGESTIONS: {
    grep: ["GREP_SENTINEL_A", "GREP_SENTINEL_B"],
    read: ["READ_SENTINEL"],
  },
}));

describe("formatDoomLoopMessage — identical-tail", () => {
  it("includes the compact fingerprint and selected tool suggestions", () => {
    const warning: DoomLoopWarning = {
      kind: "identical-tail",
      toolName: "grep",
      fingerprint: 'grep:{"glob":"*.ts","pattern":"addRoute"}',
    };

    const out = formatDoomLoopMessage(warning);

    expect(out).toContain("addRoute");
    for (const suggestion of SUGGESTIONS.grep) expect(out).toContain(suggestion);
    expect(out).not.toContain(GENERIC_SUGGESTION);
  });

  it("keeps each rendered step under 80 characters", () => {
    const warning: DoomLoopWarning = {
      kind: "identical-tail",
      toolName: "grep",
      fingerprint:
        'grep:{"ignoreCase":true,"limit":50,"pattern":"reallylongpatternthatshouldgettruncatedbecauseitistoolong","path":"src"}',
    };

    const out = formatDoomLoopMessage(warning);
    const fingerprintLine = out
      .split("\n")
      .find((line) => line.trim().startsWith("•") || line.includes("grep"));
    expect(fingerprintLine).toBeDefined();
    const compactLine = out.split("\n").find((line) => /^\s*[→•-]\s*grep/.test(line));
    expect(compactLine).toBeDefined();
    expect(compactLine!.length).toBeLessThanOrEqual(80);
  });

  it("falls back to a generic suggestion for unknown tools", () => {
    const warning: DoomLoopWarning = {
      kind: "identical-tail",
      toolName: "weirdtool",
      fingerprint: "weirdtool:{}",
    };
    const out = formatDoomLoopMessage(warning);
    expect(out).toContain(GENERIC_SUGGESTION);
  });
});

describe("formatDoomLoopMessage — repeated-subsequence", () => {
  it("emits ⚠ ALTERNATING-CALL WARNING, the repeating steps, and suggestions for each distinct tool", () => {
    const out = formatDoomLoopMessage({
      kind: "repeated-subsequence",
      toolName: "read",
      fingerprint: 'read:{"path":"src/bar.ts"}',
      steps: [
        { toolName: "grep", input: { pattern: "foo" } },
        { toolName: "read", input: { path: "src/bar.ts" } },
      ],
    });

    const stepLines = out.split("\n").filter((line) => /^\s*[→•-]\s*(grep|read)\b/.test(line));
    expect(stepLines.length).toBeGreaterThanOrEqual(2);
    for (const line of stepLines) expect(line.length).toBeLessThanOrEqual(80);

    const grepIdx = out.indexOf(SUGGESTIONS.grep[0]);
    const readIdx = out.indexOf(SUGGESTIONS.read[0]);
    expect(grepIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(-1);
    expect(grepIdx).toBeLessThan(readIdx);
  });

  it("dedupes distinct tools and falls back to the generic line for unknown ones", () => {
    const out = formatDoomLoopMessage({
      kind: "repeated-subsequence",
      toolName: "read",
      fingerprint: 'read:{"path":"a"}',
      steps: [
        { toolName: "read", input: { path: "a" } },
        { toolName: "weirdtool", input: {} },
        { toolName: "read", input: { path: "a" } },
      ],
    });

    expect(out.split(SUGGESTIONS.read[0])).toHaveLength(2);
    expect(out).toContain(GENERIC_SUGGESTION);
  });
});
