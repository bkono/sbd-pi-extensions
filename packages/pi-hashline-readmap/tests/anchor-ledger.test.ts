import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import init from "../index.js";
import { anchorsInText, diffLineMap, freshAnchorWindows } from "../src/anchor-ledger.js";
import { applyHashlineEdits, computeLineHash, ensureHashInit } from "../src/hashline.js";

const a = (line: number, text: string) => `${line}:${computeLineHash(line, text)}`;
const textOf = (result: any): string =>
  (result.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("\n");

let dir: string;
let tools: Record<string, any>;

function harness() {
  const registered: Record<string, any> = {};
  init({
    registerTool(def: any) {
      registered[def.name] = def;
    },
    on() {},
    events: { emit() {}, on() {} },
  } as any);
  return registered;
}

const call = (name: string, params: any) =>
  tools[name].execute(`${name}-call`, params, new AbortController().signal, () => {}, {
    cwd: dir,
  });

function fixture(name: string, lines: string[]): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}
const linesOf = (filePath: string) => readFileSync(filePath, "utf8").split("\n").slice(0, -1);

beforeAll(async () => {
  await ensureHashInit();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anchor-ledger-"));
  tools = harness();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete (globalThis as any).__hashlineToolExecutors;
});

describe("anchor ledger through the edit tool", () => {
  it("carries an earlier read's anchor through a shifting edit to the same physical line", async () => {
    const file = fixture("shift.ts", ["first", "", "keep1", "keep2", "", "last"]);
    await call("read", { path: file });

    const deleteFirst = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(1, "first"), new_text: "" } }],
    });
    expect(deleteFirst.isError).not.toBe(true);
    expect(linesOf(file)).toEqual(["", "keep1", "keep2", "", "last"]);

    // 5:<blank> from the first read now names line 4; line 5 is "last".
    const second = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(5, ""), new_text: "MOVED" } }],
    });
    expect(second.isError).not.toBe(true);
    expect(linesOf(file)).toEqual(["", "keep1", "keep2", "MOVED", "last"]);
  });

  it("refuses an anchor that hash-matches the current line but was never issued", async () => {
    const file = fixture("forged.ts", ["first", "", "keep1", "keep2", "", "last"]);
    await call("read", { path: file });
    await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(1, "first"), new_text: "" } }],
    });

    // Line 4 is blank now, so 4:<blank> verifies by hash alone, but it was issued as 4:<keep2>.
    const forged = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(4, ""), new_text: "WRONG" } }],
    });
    expect(forged.isError).toBe(true);
    expect(forged.details.ptcValue.error.code).toBe("stale-anchor");
    expect(textOf(forged)).toContain(`${a(4, "")} was not issued`);
    expect(linesOf(file)).toEqual(["", "keep1", "keep2", "", "last"]);

    // The refusal showed line 4 with its anchor, so a retry with it goes through.
    const retry = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(4, ""), new_text: "RIGHT" } }],
    });
    expect(retry.isError).not.toBe(true);
    expect(linesOf(file)).toEqual(["", "keep1", "keep2", "RIGHT", "last"]);
  });

  it("accepts a second edit from the same read without a re-read", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const file = fixture("two-edits.ts", lines);
    await call("read", { path: file });

    const first = await call("edit", {
      path: file,
      edits: [{ insert_after: { anchor: a(3, "line 3"), new_text: "added A\nadded B" } }],
    });
    expect(first.isError).not.toBe(true);
    const second = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(30, "line 30"), new_text: "line 30 changed" } }],
    });
    expect(second.isError).not.toBe(true);
    expect(linesOf(file)[31]).toBe("line 30 changed");
  });

  it("returns fresh anchors for the changed region, and they are accepted", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const file = fixture("fresh.ts", lines);
    await call("read", { path: file });
    const result = await call("edit", {
      path: file,
      edits: [{ insert_after: { anchor: a(10, "line 10"), new_text: "new 11\nnew 12" } }],
    });
    const text = textOf(result);
    expect(text).toContain(
      "Fresh anchors (anchors you already hold for unchanged lines still work):",
    );
    expect(anchorsInText(text).map((x) => x.line)).toEqual([9, 10, 11, 12, 13, 14]);
    expect(text).toContain(`${a(12, "new 12")}|new 12`);

    const followUp = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(12, "new 12"), new_text: "new 12 fixed" } }],
    });
    expect(followUp.isError).not.toBe(true);
    expect(linesOf(file)[11]).toBe("new 12 fixed");
  });

  it("refuses anchors after the file changed outside the edit tool", async () => {
    const file = fixture("outside.ts", ["a", "b", "c"]);
    await call("read", { path: file });
    writeFileSync(file, "inserted\na\nb\nc\n", "utf8");

    const stale = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(2, "b"), new_text: "B" } }],
    });
    expect(stale.isError).toBe(true);
    expect(stale.details.ptcValue.error.code).toBe("stale-anchor");
    expect(textOf(stale)).toContain("changed since its anchors were issued");
    expect(readFileSync(file, "utf8")).toBe("inserted\na\nb\nc\n");
  });

  it("refuses an ambiguous key once, naming the moved line; each anchor then means one line", async () => {
    const file = fixture("ambiguous.ts", ["x", "}", "y", "}", "z"]);
    await call("read", { path: file });
    // Old 4:} moves to 6; the result shows the new line 4 (old 2:}) as 4:} too.
    const insert = await call("edit", {
      path: file,
      edits: [{ insert_after: { anchor: a(1, "x"), new_text: "p\nq" } }],
    });
    expect(anchorsInText(textOf(insert))).toContainEqual({
      line: 4,
      hash: computeLineHash(4, "}"),
    });

    const ambiguous = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(4, "}"), new_text: "} // held" } }],
    });
    expect(ambiguous.details.ptcValue.error.code).toBe("stale-anchor");
    expect(textOf(ambiguous)).toContain(
      `${a(4, "}")} is ambiguous: an anchor you held from before an edit moved to line 6 (now ${a(6, "}")})`,
    );
    expect(linesOf(file)).toEqual(["x", "p", "q", "}", "y", "}", "z"]);

    // The moved line is reachable under its new anchor; the old key now means line 4.
    const moved = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(6, "}"), new_text: "} // held" } }],
    });
    expect(moved.isError).not.toBe(true);
    const own = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(4, "}"), new_text: "} // four" } }],
    });
    expect(own.isError).not.toBe(true);
    expect(linesOf(file)).toEqual(["x", "p", "q", "} // four", "y", "} // held", "z"]);
  });

  const nested = [
    "function f() {",
    "  if (a) {",
    "    g();",
    "  }",
    "  if (b) {",
    "    h();",
    "  }",
    "}",
  ];
  const shiftThree = () => ({
    insert_after: { anchor: a(1, "function f() {"), new_text: "  n1();\n  n2();\n  n3();" },
  });

  it("a later view never retargets a held anchor: refusal display, then grep context", async () => {
    // After the shift, line 7 is if(a)'s brace; the held 7:} meant if(b)'s brace, now line 10.
    const file = fixture("held.ts", nested);
    await call("read", { path: file });
    await call("edit", { path: file, edits: [shiftThree()] });
    const refused = await call("edit", {
      path: file,
      edits: [
        { set_line: { anchor: a(7, "  }"), new_text: "  } // end b" } },
        { set_line: { anchor: a(8, "    g();"), new_text: "    g(1);" } },
      ],
    });
    expect(refused.details.ptcValue.error.code).toBe("stale-anchor");
    const retry = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(7, "  }"), new_text: "  } // end b" } }],
    });
    expect(retry.details.ptcValue.error.code).toBe("stale-anchor");
    expect(textOf(retry)).toContain(`moved to line 10 (now ${a(10, "  }")})`);
    const meant = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(10, "  }"), new_text: "  } // end b" } }],
    });
    expect(meant.isError).not.toBe(true);
    expect(linesOf(file)[9]).toBe("  } // end b");
    expect(linesOf(file)[6]).toBe("  }");

    const file2 = fixture("held2.ts", nested);
    await call("read", { path: file2 });
    await call("edit", { path: file2, edits: [shiftThree()] });
    await call("grep", { pattern: "g\\(\\)", path: file2, context: 1 });
    const viaGrep = await call("edit", {
      path: file2,
      edits: [{ set_line: { anchor: a(7, "  }"), new_text: "  } // end b" } }],
    });
    expect(viaGrep.details.ptcValue.error.code).toBe("stale-anchor");
    expect(linesOf(file2)[6]).toBe("  }");
  });

  it("a re-read does not loop: one refusal settles the key", async () => {
    // Live t6 failure: a `});` anchor named two lines, and re-reads could not resolve it.
    const file = fixture("loop.ts", ["a", "});", "b", "});", "c"]);
    await call("read", { path: file });
    await call("edit", {
      path: file,
      edits: [{ insert_after: { anchor: a(1, "a"), new_text: "n1\nn2" } }],
    });
    await call("read", { path: file, offset: 3, limit: 3 });
    const edit = () =>
      call("edit", {
        path: file,
        edits: [{ insert_after: { anchor: a(4, "});"), new_text: "after four" } }],
      });
    expect((await edit()).details.ptcValue.error.code).toBe("stale-anchor");
    expect((await edit()).isError).not.toBe(true);
    expect(linesOf(file)).toEqual(["a", "n1", "n2", "});", "after four", "b", "});", "c"]);
  });

  it("moves anchors exactly past a replace_symbol splice instead of relocating by hash", async () => {
    const lines = [
      "function a() {",
      "  return 1;",
      "}",
      ...Array.from({ length: 5 }, (_, i) => `const f${i} = ${i};`),
      "function b() {",
      "  if (x) {",
      "    y();",
      "  }",
      "  return 2;",
      "}",
    ];
    const file = fixture("rs.ts", lines);
    await call("read", { path: file });
    const body = [
      "function a() {",
      "  if (q) {",
      ...Array.from({ length: 15 }, (_, i) => `    s${i}();`),
      "  }",
      ...Array.from({ length: 25 }, (_, i) => `  t${i}();`),
      "  return 1;",
      "}",
    ].join("\n");
    const result = await call("edit", {
      path: file,
      edits: [
        { replace_symbol: { symbol: "a", new_body: body } },
        { set_line: { anchor: a(12, "  }"), new_text: "  } // MARK" } },
      ],
    });
    expect(result.isError).not.toBe(true);
    expect(linesOf(file).findIndex((l) => l.includes("MARK")) + 1).toBe(12 + 42);
  });

  it("issues ptcValue anchors past the read text's truncation", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `row ${i + 1}`);
    const file = fixture("long.ts", lines);
    const read = await call("read", { path: file });
    expect(textOf(read)).not.toContain(`${a(2400, "row 2400")}|`);
    const result = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(2400, "row 2400"), new_text: "edited" } }],
    });
    expect(result.isError).not.toBe(true);
    expect(linesOf(file)[2399]).toBe("edited");
  });

  it("still refuses an edit to a file that was never read", async () => {
    const file = fixture("unread.ts", ["a"]);
    const result = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(1, "a"), new_text: "b" } }],
    });
    expect(result.details.ptcValue.error.code).toBe("file-not-read");
  });

  it("issues grep anchors", async () => {
    const file = fixture("grep.ts", ["alpha", "needle here", "omega"]);
    await call("grep", { pattern: "needle", path: file });
    const result = await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(2, "needle here"), new_text: "found" } }],
    });
    expect(result.isError).not.toBe(true);
    expect(linesOf(file)).toEqual(["alpha", "found", "omega"]);
  });

  it("keeps replace edits working after the file's own earlier edit", async () => {
    const file = fixture("replace.ts", ["const a = 1;", "const b = 2;"]);
    await call("read", { path: file });
    await call("edit", {
      path: file,
      edits: [{ set_line: { anchor: a(1, "const a = 1;"), new_text: "const a = 10;" } }],
    });
    const replace = await call("edit", {
      path: file,
      edits: [{ replace: { old_text: "const b = 2;", new_text: "const b = 20;" } }],
    });
    expect(replace.isError).not.toBe(true);
    expect(linesOf(file)).toEqual(["const a = 10;", "const b = 20;"]);
  });
});

describe("diffLineMap", () => {
  it("maps unchanged lines across an insert and a deletion", () => {
    const map = diffLineMap(["a", "b", "c", "d"], ["a", "x", "b", "d"]);
    expect([...map.oldToNew]).toEqual([1, 3, 0, 4]);
    expect(map.changed).toEqual([[2, 2]]);
    expect(map.deletions).toEqual([4]);
  });
});

describe("freshAnchorWindows", () => {
  it("shows the head and tail of a long region and stays within the total budget", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `l${i}`);
    const changed: Array<[number, number]> = [
      [10, 60],
      [100, 101],
      [200, 201],
      [300, 301],
      [350, 351],
      [380, 381],
    ];
    const map = { oldToNew: new Int32Array(0), changed, deletions: [], newLength: 400 };
    const { shown, omittedRegions } = freshAnchorWindows(lines, map);
    expect(shown[0]).toEqual([8, 9, 10, 11, 12, 13, 57, 58, 59, 60, 61, 62]);
    expect(shown.flat().length).toBeLessThanOrEqual(48);
    expect(shown.length + omittedRegions).toBe(6);
  });
});

describe("reformat warning", () => {
  it("is gone: a mid-file insert_after returns no warning", () => {
    const content = Array.from({ length: 700 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = applyHashlineEdits(content, [
      { insert_after: { anchor: a(5, "line 5"), new_text: "one\ntwo\nthree" } },
    ]);
    expect(result.warnings).toBeUndefined();
  });
});
