import { mkdtempSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
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

describe("repro 109 — anchor contract", () => {
  it("allows grep anchors to be edited without an intermediate read", async () => {
    const tools = captureTools();
    const dir = mkdtempSync(join(tmpdir(), "pi-repro-109-grep-"));
    const filePath = resolve(dir, "sample.ts");
    await writeFile(filePath, "const value = 1;\nconst other = 2;\n", "utf8");

    const grepResult = await tools.grep.execute(
      "grep-call",
      { pattern: "value", path: filePath, literal: true },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );
    const grepText = getTextContent(grepResult);
    const anchor = grepText.match(/:(?:>>| {2})(\d+:[0-9a-f]{3})\|/)?.[1];
    expect(anchor).toBeDefined();

    const editResult = await tools.edit.execute(
      "edit-call",
      { path: filePath, edits: [{ set_line: { anchor, new_text: "const value = 2;" } }] },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(editResult.isError).toBeFalsy();
    expect(readFileSync(filePath, "utf8")).toContain("const value = 2;");

    await rm(dir, { recursive: true, force: true });
  });

  it("allows ast_search anchors to be edited without an intermediate read", async () => {
    const tools = captureTools();
    const dir = mkdtempSync(join(tmpdir(), "pi-repro-109-sg-"));
    const filePath = resolve(dir, "sample.ts");
    await writeFile(filePath, "const value = 1;\nconst other = 2;\n", "utf8");

    const searchResult = await (globalThis as any).__hashlineToolExecutors.ast_search.execute(
      "sg-call",
      { pattern: "const $NAME = $_", lang: "typescript", path: filePath },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );
    const searchText = getTextContent(searchResult);
    const anchor = searchText.match(/>>(\d+:[0-9a-f]{3})\|/)?.[1];
    expect(anchor).toBeDefined();

    const editResult = await tools.edit.execute(
      "edit-call",
      { path: filePath, edits: [{ set_line: { anchor, new_text: "const value = 2;" } }] },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(editResult.isError).toBeFalsy();
    expect(readFileSync(filePath, "utf8")).toContain("const value = 2;");

    await rm(dir, { recursive: true, force: true });
  });

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

  it("keeps every written line's anchor in ptcValue for programmatic callers", async () => {
    const tools = captureTools();
    const dir = mkdtempSync(join(tmpdir(), "pi-repro-109-trunc-"));
    const filePath = resolve(dir, "long.txt");
    const content = Array.from({ length: 2003 }, (_, index) => `line ${index + 1}`).join("\n");

    const writeResult = await tools.write.execute(
      "write-call",
      { path: filePath, content },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(writeResult.details?.ptcValue?.lines).toHaveLength(2003);

    await rm(dir, { recursive: true, force: true });
  });
});
