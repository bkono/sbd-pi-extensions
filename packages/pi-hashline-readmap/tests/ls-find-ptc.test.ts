import { describe, expect, it, vi } from "vitest";
import { registerFindTool } from "../src/find.js";
import { registerLsTool } from "../src/ls.js";

describe("ls/find ptc metadata", () => {
  it("attaches read-only ptc metadata to ls and find tool definitions", () => {
    const pi = { registerTool: vi.fn() };

    const lsTool = registerLsTool(pi as any);
    const findTool = registerFindTool(pi as any);

    expect(lsTool.ptc).toMatchObject({
      pythonName: "ls",
      policy: "read-only",
      defaultExposure: "safe-by-default",
    });
    expect(findTool.ptc).toMatchObject({
      pythonName: "find",
      policy: "read-only",
      defaultExposure: "safe-by-default",
    });
  });
});
