import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { registerEditTool } from "../src/edit.js";
import { buildEditOutput } from "../src/edit-output.js";
import { computeLineHash, ensureHashInit } from "../src/hashline.js";

function replacementHint(): string {
  const base = {
    path: "fixture.ts",
    displayPath: "fixture.ts",
    diff: "",
    firstChangedLine: undefined,
    warnings: [],
    noopEdits: [],
  };
  const withoutHint = buildEditOutput(base).text;
  const withHint = buildEditOutput({
    ...base,
    edits: [{ replace: { old_text: "before", new_text: "after" } }],
  }).text;
  const hint = withHint.slice(withoutHint.length).trim();
  expect(hint.length).toBeGreaterThan(0);
  return hint;
}

async function callEditTool(params: Record<string, unknown>) {
  let capturedTool: any = null;
  registerEditTool({
    registerTool(def: any) {
      capturedTool = def;
    },
  } as any);
  if (!capturedTool) throw new Error("edit tool was not registered");
  return capturedTool.execute("test-call", params, new AbortController().signal, () => {}, {
    cwd: process.cwd(),
  });
}

function makeFixture(content: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), "pi-edit-replace-hint-"));
  const filePath = resolve(dir, "sample.ts");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function getTextContent(result: any): string {
  return result.content.find((c: any) => c.type === "text")?.text ?? "";
}

describe("edit replace hint", () => {
  beforeAll(async () => {
    await ensureHashInit();
  });

  it("adds the info line for successful replace-only batches", async () => {
    const filePath = makeFixture("const value = 1;\n");
    const result = await callEditTool({
      path: filePath,
      edits: [{ replace: { old_text: "const value = 1;", new_text: "const value = 2;" } }],
    });

    const text = getTextContent(result);
    expect(result.isError).not.toBe(true);
    expect(text.endsWith(replacementHint())).toBe(true);
  });

  it("omits the info line for anchored-only batches", async () => {
    const filePath = makeFixture("const value = 1;\n");
    const anchor = `1:${computeLineHash(1, "const value = 1;")}`;

    const result = await callEditTool({
      path: filePath,
      edits: [{ set_line: { anchor, new_text: "const value = 2;" } }],
    });

    expect(getTextContent(result)).not.toContain(replacementHint());
  });

  it("omits the info line for mixed anchored-plus-replace batches", async () => {
    const filePath = makeFixture("const one = 1;\nconst two = 2;\n");
    const anchor = `1:${computeLineHash(1, "const one = 1;")}`;

    const result = await callEditTool({
      path: filePath,
      edits: [
        { set_line: { anchor, new_text: "const one = 11;" } },
        { replace: { old_text: "const two = 2;", new_text: "const two = 22;" } },
      ],
    });

    expect(getTextContent(result)).not.toContain(replacementHint());
  });

  it("puts the info line after warnings for legacy replace-only success", async () => {
    const filePath = makeFixture("const two = 2;\n");
    const result = await callEditTool({
      path: filePath,
      oldText: "const two = 2;",
      newText: "const two = 22;",
    });

    const text = getTextContent(result);
    expect(result.isError).not.toBe(true);
    const hint = replacementHint();
    const warnings = result.details.ptcValue.warnings;
    expect(warnings).toEqual(expect.arrayContaining([expect.any(String)]));
    for (const warning of warnings) {
      expect(text).toContain(warning);
      expect(text.indexOf(warning)).toBeLessThan(text.indexOf(hint));
    }
    expect(text.endsWith(hint)).toBe(true);
  });

  it("suppresses the info line for replace no-op results", async () => {
    const filePath = makeFixture("const value = 1;\n");
    const result = await callEditTool({
      path: filePath,
      edits: [{ replace: { old_text: "const value = 1;", new_text: "const value = 1;" } }],
    });

    expect(result.isError).toBe(true);
    const text = getTextContent(result);
    expect(result.details.ptcValue.error.code).toBe("no-op");
    expect(text).not.toContain(replacementHint());
  });
});
