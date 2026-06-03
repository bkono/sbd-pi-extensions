import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fix = (name: string) => readFileSync(resolve(__dirname, "fixtures", name), "utf8");

describe("bash filter fixtures", () => {
  it("fixtures exist and contain realistic output", () => {
    const vitestPass = fix("vitest-pass.txt");
    expect(vitestPass).toMatch(/Test Files\s+\d+ passed/);

    const vitestFail = fix("vitest-fail.txt");
    expect(vitestFail).toContain("FAIL");
    expect(vitestFail).toMatch(/Expected|Received/);

    const tscErrors = fix("tsc-errors.txt");
    const tsErrors = tscErrors.match(/error TS\d+/g);
    expect(tsErrors?.length ?? 0).toBeGreaterThanOrEqual(3);

    const gitDiff = fix("git-diff-large.txt");
    const hunks = gitDiff.match(/^@@/gm);
    expect(hunks?.length ?? 0).toBeGreaterThanOrEqual(5);

    const eslintOutput = fix("eslint-output.txt");
    const issues = eslintOutput.match(/^\s+\d+:\d+\s+(error|warning)/gm);
    expect(issues?.length ?? 0).toBeGreaterThanOrEqual(5);
  });
});
