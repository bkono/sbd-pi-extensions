import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerReadTool } from "../src/read.js";

function captureReadTool() {
  let capturedTool: any;
  registerReadTool({
    registerTool(def: any) {
      capturedTool = def;
    },
  } as any);
  return capturedTool;
}

describe("issue #081 regression — negative limit", () => {
  it("returns a clear error instead of a garbled range for the exact reproduction steps", async () => {
    const tool = captureReadTool();
    const dir = mkdtempSync(join(tmpdir(), "pi-read-081-neg-limit-"));
    const filePath = join(dir, "pi-read-negative-noeof.ts");
    writeFileSync(filePath, "const x = 1;", "utf8");

    try {
      const result = await tool.execute(
        "read-081-negative-limit",
        { path: filePath, offset: -5, limit: -10 },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );

      expect(result.isError).toBe(true);
      expect(result.details?.ptcValue).toMatchObject({
        tool: "read",
        ok: false,
        path: filePath,
        error: {
          code: "invalid-limit",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
