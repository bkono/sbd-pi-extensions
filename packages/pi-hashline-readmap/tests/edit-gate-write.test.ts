import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import piHashlineReadmapExtension from "../index.ts";

function captureTools() {
  const tools: Record<string, any> = {};
  const pi = {
    registerTool(def: any) {
      tools[def.name] = def;
    },
    on() {},
    events: { emit() {}, on() {} },
  };
  piHashlineReadmapExtension(pi as any);
  return tools;
}

function getTextContent(result: any): string {
  return result.content?.find((item: any) => item.type === "text")?.text ?? "";
}

describe("edit gate — write anchors", () => {
  it("shows no anchors; an anchored edit after write needs a read, a text replace does not", async () => {
    const tools = captureTools();
    const dir = mkdtempSync(join(tmpdir(), "pi-write-summary-"));
    const filePath = resolve(dir, "written.ts");
    const run = (name: string, params: unknown) =>
      tools[name].execute(`${name}-call`, params, new AbortController().signal, () => {}, {
        cwd: process.cwd(),
      });
    try {
      const writeResult = await run("write", { path: filePath, content: "export const x = 1;\n" });
      const writeText = getTextContent(writeResult);
      expect(writeText).toMatch(/^Created .*written\.ts \(1 line\)\./);
      expect(writeText).not.toMatch(/^\d+:[0-9a-f]{3}\|/m);

      const anchor = writeResult.details.ptcValue.lines[0].anchor;
      const blind = await run("edit", {
        path: filePath,
        edits: [{ set_line: { anchor, new_text: "export const x = 2;" } }],
      });
      expect(blind.details.ptcValue.error.code).toBe("stale-anchor");

      const replaced = await run("edit", {
        path: filePath,
        edits: [{ replace: { old_text: "x = 1", new_text: "x = 2" } }],
      });
      expect(replaced.isError).toBeFalsy();
      expect(readFileSync(filePath, "utf8")).toContain("export const x = 2;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
