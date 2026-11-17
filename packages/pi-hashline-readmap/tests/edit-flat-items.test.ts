/* biome-ignore-all lint/suspicious/noExplicitAny: registered tools and results are dynamic. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import init from "../index.js";
import { countEditTypes } from "../src/edit-render-helpers.js";
import { computeLineHash, ensureHashInit } from "../src/hashline.js";
import { buildPendingEditPreviewData } from "../src/pending-diff-preview.js";

const a = (line: number, text: string) => `${line}:${computeLineHash(line, text)}`;
let dir: string;
let tools: Record<string, any>;
const call = (name: string, params: any) =>
  tools[name].execute(`${name}-c`, params, new AbortController().signal, () => {}, { cwd: dir });
const linesOf = (f: string) => readFileSync(f, "utf8").split("\n").slice(0, -1);

beforeAll(async () => {
  await ensureHashInit();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flat-items-"));
  const reg: Record<string, any> = {};
  init({
    registerTool: (d: any) => {
      reg[d.name] = d;
    },
    on() {},
    events: { emit() {}, on() {} },
  } as any);
  tools = reg;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete (globalThis as any).__hashlineToolExecutors;
});

describe("flat {op, ...} edit items", () => {
  it("apply every op through the edit tool", async () => {
    const file = join(dir, "f.ts");
    writeFileSync(file, "one\ntwo\nthree\nfour\nfive\n");
    await call("read", { path: file });
    const result = await call("edit", {
      path: file,
      edits: [
        { op: "set_line", anchor: a(1, "one"), new_text: "ONE" },
        {
          op: "replace_lines",
          start_anchor: a(2, "two"),
          end_anchor: a(3, "three"),
          new_text: "MID",
        },
        { op: "insert_after", anchor: a(4, "four"), new_text: "four-and-a-half" },
        { op: "replace", old_text: "five", new_text: "FIVE" },
      ],
    });
    expect(result.isError).not.toBe(true);
    expect(linesOf(file)).toEqual(["ONE", "MID", "four", "four-and-a-half", "FIVE"]);
  });

  it("still accepts the nested shape from programmatic callers", async () => {
    const file = join(dir, "g.ts");
    writeFileSync(file, "x\ny\n");
    await call("read", { path: file });
    const result = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(2, "y"), new_text: "Y" } }],
    });
    expect(result.isError).not.toBe(true);
    expect(linesOf(file)).toEqual(["x", "Y"]);
  });

  it("names an unknown op in the error", async () => {
    const file = join(dir, "h.ts");
    writeFileSync(file, "x\n");
    await call("read", { path: file });
    const result = await call("edit", {
      path: file,
      edits: [{ op: "insert_before", anchor: a(1, "x"), new_text: "w" }],
    });
    expect(result.details.ptcValue.error.code).toBe("invalid-edit-variant");
    expect(result.content[0].text).toContain('needs op "set_line"');
  });

  it("are counted and previewed like nested items", async () => {
    const flat = [
      { op: "set_line", anchor: "1:abc", new_text: "x" },
      { op: "insert_after", anchor: "1:abc", new_text: "y" },
      { op: "replace", old_text: "a", new_text: "b" },
    ];
    expect(countEditTypes(flat)).toMatchObject({
      set_line: 1,
      insert_after: 1,
      replace: 1,
      total: 3,
    });
    const file = join(dir, "p.ts");
    writeFileSync(file, "alpha\nbeta\n");
    const preview = await buildPendingEditPreviewData(
      { path: file, edits: [{ op: "set_line", anchor: a(2, "beta"), new_text: "BETA" }] },
      dir,
    );
    expect(preview.type).toBe("ok");
    if (preview.type === "ok") expect(preview.data.nextContent).toBe("alpha\nBETA\n");
  });

  it("refuses a field from another op instead of silently dropping it", async () => {
    const file = join(dir, "s.ts");
    writeFileSync(file, "one\ntwo\nthree\n");
    await call("read", { path: file });
    const ranged = await call("edit", {
      path: file,
      edits: [{ op: "set_line", anchor: a(1, "one"), end_anchor: a(3, "three"), new_text: "X" }],
    });
    expect(ranged.details.ptcValue.error.code).toBe("invalid-edit-variant");
    expect(ranged.content[0].text).toContain("end_anchor, which belongs to another op");
    const hybrid = await call("edit", {
      path: file,
      edits: [{ op: "set_line", set_line: { anchor: a(1, "one"), new_text: "X" } }],
    });
    expect(hybrid.details.ptcValue.error.code).toBe("invalid-edit-variant");
    expect(linesOf(file)).toEqual(["one", "two", "three"]);
  });

  it("refuses a missing field with an error, not an exception, and ignores unknown keys", async () => {
    const file = join(dir, "m.ts");
    writeFileSync(file, "one\n");
    await call("read", { path: file });
    const missing = await call("edit", {
      path: file,
      edits: [{ op: "set_line", anchor: a(1, "one") }],
    });
    expect(missing.details.ptcValue.error.code).toBe("invalid-edit-variant");
    expect(missing.content[0].text).toContain("missing new_text");
    const nestedMissing = await call("edit", {
      path: file,
      edits: [{ replace: { new_text: "x" } }],
    });
    expect(nestedMissing.details.ptcValue.error.code).toBe("invalid-edit-variant");
    const junk = await call("edit", {
      path: file,
      edits: [{ op: "set_line", anchor: a(1, "one"), new_text: "ONE", why: "rename" }],
    });
    expect(junk.isError).not.toBe(true);
    expect(linesOf(file)).toEqual(["ONE"]);
  });

  it("treats a null stray field as unset, and names the op a stray field belongs to", async () => {
    const file = join(dir, "n.ts");
    writeFileSync(file, "one\ntwo\n");
    await call("read", { path: file });
    const nulled = await call("edit", {
      path: file,
      edits: [{ op: "set_line", anchor: a(1, "one"), new_text: "ONE", end_anchor: null }],
    });
    expect(nulled.isError).not.toBe(true);
    const stray = await call("edit", {
      path: file,
      edits: [{ op: "set_line", anchor: a(2, "two"), new_text: "x", old_text: "two" }],
    });
    expect(stray.content[0].text).toContain('belongs to op "replace"');
    const proto = await call("edit", {
      path: file,
      edits: [{ op: "toString", anchor: a(2, "two"), new_text: "x" }],
    });
    expect(proto.details.ptcValue.error.code).toBe("invalid-edit-variant");
    expect(linesOf(file)).toEqual(["ONE", "two"]);
  });
});
