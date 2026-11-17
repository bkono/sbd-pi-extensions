import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { registerEditTool } from "../src/edit.js";
import { computeLineHash, ensureHashInit } from "../src/hashline.js";

function captureEditTool() {
  let capturedTool: any = null;
  registerEditTool({
    registerTool(def: any) {
      capturedTool = def;
    },
  } as any);
  if (!capturedTool) throw new Error("edit tool was not registered");
  return capturedTool;
}

function getTextContent(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}

describe("issue #082 reproduction — duplicate anchors in one edit batch", () => {
  beforeAll(async () => {
    await ensureHashInit();
  });

  it("refuses multiple conflicting set_line operations on the same anchor in one batch", async () => {
    const tool = captureEditTool();
    const dir = mkdtempSync(resolve(tmpdir(), "pi-repro-082-"));
    const filePath = resolve(dir, "sample.ts");
    writeFileSync(filePath, ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n"), "utf8");

    try {
      const originalLines = readFileSync(filePath, "utf8").split("\n");
      const anchor = `3:${computeLineHash(3, originalLines[2])}`;

      const result = await tool.execute(
        "repro-082-duplicate-anchor-warning",
        {
          path: filePath,
          edits: [
            { set_line: { anchor, new_text: "const c = 30;" } },
            { set_line: { anchor, new_text: "const c = 300;" } },
          ],
        },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );

      // Conflicting edits to one line are refused; nothing is written.
      expect(result.details.ptcValue.error.code).toBe("overlapping-edits");
      expect(getTextContent(result)).toContain("overlap");
      expect(readFileSync(filePath, "utf8")).toBe(originalLines.join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
