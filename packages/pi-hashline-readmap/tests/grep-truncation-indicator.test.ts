import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatGrepOutput, type GrepIR, type GrepIRLine } from "../src/grep";
import { registerGrepTool } from "../src/grep.js";

describe("grep summary at the match limit", () => {
  it("renders summary data at the match limit without anchors", () => {
    const lines: GrepIRLine[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "match" as const,
      raw: `src/foo.ts:>>${i + 1}:ab|line ${i}`,
    }));
    const ir: GrepIR = {
      totalMatches: 5,
      files: [{ path: "src/foo.ts", matchCount: 5, lines }],
    };
    const output = formatGrepOutput(ir, { summary: true, limit: 5 });
    expect(output).toContain("5");
    expect(output).toContain("src/foo.ts");
    // No hashline anchors in summary mode
    expect(output).not.toMatch(/\d+:[0-9a-f]{3}\|/);
  });
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");
async function callGrepToolTruncation(params: {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  limit?: number;
  summary?: boolean;
}) {
  let capturedTool: any = null;
  const mockPi = {
    registerTool(def: any) {
      capturedTool = def;
    },
  };
  registerGrepTool(mockPi as any);
  return capturedTool.execute("test-call", params, new AbortController().signal, () => {}, {
    cwd: process.cwd(),
  });
}

describe("grep truncation indicator integration", () => {
  it("limits returned matches", async () => {
    // pattern "e" produces 34 matches in small.ts; limit=2 ensures totalMatches === 2 === limit
    const result = await callGrepToolTruncation({
      pattern: "e",
      path: resolve(fixturesDir, "small.ts"),
      limit: 2,
    });
    expect(result.details.ptcValue.totalMatches).toBe(2);
    expect(
      result.details.ptcValue.records.filter((record: any) => record.kind === "match"),
    ).toHaveLength(2);
  });
});
