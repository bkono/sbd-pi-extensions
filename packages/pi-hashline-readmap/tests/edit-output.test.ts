import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as editModule from "../src/edit.js";
import * as editOutputModule from "../src/edit-output.js";
import { computeLineHash, ensureHashInit } from "../src/hashline.js";

async function callEditTool(params: Record<string, unknown>) {
  let capturedTool: any = null;
  const mockPi = {
    registerTool(def: any) {
      capturedTool = def;
    },
  };
  editModule.registerEditTool(mockPi as any);
  if (!capturedTool) throw new Error("edit tool was not registered");
  return capturedTool.execute("test-call", params, new AbortController().signal, () => {}, {
    cwd: process.cwd(),
  });
}
function makeFixtureFile(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "pi-edit-output-"));
  const filePath = resolve(dir, "sample.ts");
  writeFileSync(
    filePath,
    ["const one = 1;", "const two = 2;", "const three = 3;"].join("\n"),
    "utf-8",
  );
  return filePath;
}
function getTextContent(result: any): string {
  return result.content.find((c: any) => c.type === "text")?.text ?? "";
}
describe("buildEditOutput", () => {
  beforeAll(async () => {
    await ensureHashInit();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("projects successful anchor-edit results through one shared builder", async () => {
    const spy = vi.spyOn(editOutputModule, "buildEditOutput");
    const filePath = makeFixtureFile();
    const originalLines = readFileSync(filePath, "utf-8").split("\n");
    const anchor1 = `1:${computeLineHash(1, originalLines[0])}`;
    const anchor2 = `2:${computeLineHash(2, originalLines[1])}`;
    const result = await callEditTool({
      path: filePath,
      edits: [
        { set_line: { anchor: anchor1, new_text: originalLines[0] } },
        { set_line: { anchor: anchor2, new_text: "const two = 22;" } },
      ],
    });

    const built = spy.mock.results.at(-1)?.value;
    expect(getTextContent(result)).toBe(built.text);
    expect(result.details?.ptcValue).toEqual(built.ptcValue);
  });
  it("projects legacy normalization warnings through the shared builder", async () => {
    const spy = vi.spyOn(editOutputModule, "buildEditOutput");
    const filePath = makeFixtureFile();

    const result = await callEditTool({
      path: filePath,
      oldText: "const two = 2;",
      newText: "const two = 22;",
    });

    const built = spy.mock.results.at(-1)?.value;
    expect(built.ptcValue.warnings.length).toBeGreaterThan(0);
    expect(getTextContent(result)).toBe(built.text);
    expect(result.details?.ptcValue).toEqual(built.ptcValue);
  });
});
