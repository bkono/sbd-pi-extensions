import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registerReadTool } from "../src/read.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

function captureReadTool() {
  let capturedTool: any;
  registerReadTool({
    registerTool(def: any) {
      capturedTool = def;
    },
  } as any);
  return capturedTool;
}

describe("issue #081 regression — zero limit", () => {
  it("treats numeric and string zero limits as invalid instead of as 'no limit'", async () => {
    const tool = captureReadTool();
    const filePath = resolve(fixturesDir, "small.ts");

    const numericZero = await tool.execute(
      "read-081-zero-limit-number",
      { path: filePath, limit: 0 },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(numericZero.isError).toBe(true);
    expect(numericZero.details?.ptcValue).toMatchObject({
      tool: "read",
      ok: false,
      path: filePath,
      error: {
        code: "invalid-limit",
      },
    });

    const stringZero = await tool.execute(
      "read-081-zero-limit-string",
      { path: filePath, limit: "0" },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(stringZero.isError).toBe(true);
    expect(stringZero.details?.ptcValue).toMatchObject({
      tool: "read",
      ok: false,
      path: filePath,
      error: {
        code: "invalid-limit",
      },
    });
  });
});
