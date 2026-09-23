import { describe, expect, it } from "vitest";
import { getBashAntiPatternHint } from "../src/rtk/bash-anti-pattern-hints.js";
import { filterBashOutput } from "../src/rtk/bash-filter.js";

describe("bash anti-pattern hints", () => {
  it.each([
    "cat src/read.ts",
    "grep -n hashline src/read.ts",
    "rg hashline src",
    "sed -n '1,20p' src/read.ts",
    "find src -name '*.ts'",
  ])("appends the selected hint without replacing output for %s", (command) => {
    const hint = getBashAntiPatternHint(command);
    expect(hint).toEqual(expect.any(String));
    const out = filterBashOutput(command, "body sentinel").output;
    expect(out).toBe(`body sentinel\n\n${hint}`);
  });

  it("leaves unrelated commands unchanged", () => {
    expect(filterBashOutput("echo hello", "hello").output).toBe("hello");
  });
});
