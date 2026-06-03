import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { registerEditTool } from "../src/edit.js";
import { computeLineHash, ensureHashInit } from "../src/hashline.js";

function captureEditTool(opts?: any) {
  let captured: any = null;
  registerEditTool(
    {
      registerTool(def: any) {
        captured = def;
      },
    } as any,
    opts,
  );
  if (!captured) throw new Error("edit tool was not registered");
  return captured;
}

describe("edit postEditVerify syntax validation ordering", () => {
  beforeAll(async () => {
    await ensureHashInit();
  });

  it("block mode aborts before writing even when postEditVerify is true", async () => {
    const tool = captureEditTool({ syntaxValidate: "block" });
    const dir = mkdtempSync(resolve(tmpdir(), "pi-post-verify-syntax-block-"));
    const fp = resolve(dir, "sample.rs");
    const original = "fn a() { 1 }\n";
    writeFileSync(fp, original, "utf8");
    try {
      const anchor = `1:${computeLineHash(1, "fn a() { 1 }")}`;
      const res = await tool.execute(
        "block-post-verify",
        {
          path: fp,
          postEditVerify: true,
          edits: [
            { set_line: { anchor, new_text: "fn a( {" } },
            { insert_after: { anchor, new_text: "fn b(\n" } },
          ],
        },
        new AbortController().signal,
        () => {},
        { cwd: process.cwd() },
      );

      expect(res.isError).toBe(true);
      expect(res.details?.ptcValue?.error?.code).toBe("syntax-regression");
      expect(readFileSync(fp, "utf8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
