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

describe("sg no-match", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns empty results when sg returns []", async () => {
    const tool = await getSgTool();

    vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "[]", "");
      return {} as any;
    });

    const result = await tool.execute(
      "tc",
      { pattern: "nonExistentPattern" },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(result.isError).toBeFalsy();
    expect(result.details.ptcValue.files).toEqual([]);
  });
});
