/**
 * Reproduction test for Bug #017:
 * `sg` exits with code 1 on no matches; execFileText rejects → "Command failed" error
 */

import * as cp from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

async function getSgTool() {
  const { registerSgTool } = await import("../src/sg.js");
  let captured: any = null;
  const mockPi = {
    registerTool(def: any) {
      captured = def;
    },
  };
  registerSgTool(mockPi as any);
  if (!captured) throw new Error("sg tool was not registered");
  return captured;
}

describe("Bug #017: sg exits code 1 on no-match", () => {
  afterEach(() => vi.restoreAllMocks());

  it("handles sg exit code 1 with empty JSON as a no-match response", async () => {
    const tool = await getSgTool();

    // This is what the REAL `sg` binary does when no matches are found:
    // exits with code 1, stdout="[]", stderr=""
    vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err: any = new Error(
        "Command failed: sg run --json -p console.log($$$ARGS) -l typescript /tmp/sample.ts",
      );
      err.code = 1;
      // stdout is "[]" (empty JSON array), stderr is empty
      cb(err, "[]", "");
      return {} as any;
    });

    const result = await tool.execute(
      "tc",
      { pattern: "console.log($$$ARGS)", lang: "typescript" },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(result.isError).toBeFalsy();
    expect(result.details.ptcValue.files).toEqual([]);
  });
});
