import { beforeAll, describe, expect, it } from "vitest";
import { applyHashlineEdits, computeLineHash, ensureHashInit } from "../src/hashline.js";

const a = (line: number, text: string) => `${line}:${computeLineHash(line, text)}`;

beforeAll(async () => {
  await ensureHashInit();
});

// The engine used to "repair" edits: drop a last line matching the next file line (ignoring
// whitespace), drop a first inserted line matching the anchor, restore wrapped lines, merge
// continuation lines, and re-indent. A replay of ~470 eval edits found 6 firings, all harmful.
describe("the engine writes anchored edits exactly as sent", () => {
  it("keeps a replacement's closing line that matches the next file line", () => {
    // Replay case: Opus t4 replaced one line with a loop; its `    }` was dropped before `  }`.
    const content = [
      "function total(orders) {",
      "  for (const order of orders) {",
      "    total += order.x;",
      "  }",
      "}",
    ].join("\n");
    const result = applyHashlineEdits(content, [
      {
        set_line: {
          anchor: a(3, "    total += order.x;"),
          new_text: [
            "    for (const line of order.lines) {",
            "      total += line.x;",
            "    }",
          ].join("\n"),
        },
      },
    ]);
    expect(result.content.split("\n")).toEqual([
      "function total(orders) {",
      "  for (const order of orders) {",
      "    for (const line of order.lines) {",
      "      total += line.x;",
      "    }",
      "  }",
      "}",
    ]);
  });

  it("keeps a replacement's opening line that matches the previous file line", () => {
    const content = ["{", "  old();", "}"].join("\n");
    const result = applyHashlineEdits(content, [
      { set_line: { anchor: a(2, "  old();"), new_text: "{\n  new();\n}" } },
    ]);
    expect(result.content.split("\n")).toEqual(["{", "{", "  new();", "}", "}"]);
  });

  it("keeps an inserted first line equal to the anchor line (a blank separator)", () => {
    // Replay case: a blank line before a new describe block was dropped after a blank anchor.
    const content = ["test();", "", "tail();"].join("\n");
    const result = applyHashlineEdits(content, [
      { insert_after: { anchor: a(2, ""), new_text: "\ndescribe();" } },
    ]);
    expect(result.content.split("\n")).toEqual(["test();", "", "", "describe();", "tail();"]);
  });

  it("does not re-indent or merge: a single-line set_line replaces only its own line", () => {
    const content = ["  const x = a +", "    b;", "  return x;"].join("\n");
    const result = applyHashlineEdits(content, [
      { set_line: { anchor: a(1, "  const x = a +"), new_text: "const x = a + b;" } },
    ]);
    expect(result.content.split("\n")).toEqual(["const x = a + b;", "    b;", "  return x;"]);
  });

  it("still strips LINE:HASH prefixes the model copied into new_text", () => {
    const content = ["one", "two"].join("\n");
    const result = applyHashlineEdits(content, [
      { set_line: { anchor: a(2, "two"), new_text: `2:${computeLineHash(2, "TWO")}|TWO` } },
    ]);
    expect(result.content).toBe("one\nTWO");
  });
});
