import { beforeAll, describe, expect, it } from "vitest";
import { applyHashlineEdits, computeLineHash, ensureHashInit } from "../src/hashline.js";

describe("repro 199 — hash-only prefixes are stripped from new_text", () => {
  beforeAll(async () => {
    await ensureHashInit();
  });

  // A copied prefix is a real hash of its own line; only those are stripped.
  const h = (text: string) => computeLineHash(0, text);

  it("strips copied hash-only prefixes in set_line new_text", () => {
    const orig = ["alpha", "beta", "gamma"].join("\n");
    const anchor = `2:${computeLineHash(2, "beta")}`;
    const res = applyHashlineEdits(
      orig,
      [
        {
          set_line: {
            anchor,
            new_text: `${h("beta-modified")}|beta-modified\n${h("extra-line")}|extra-line`,
          },
        },
      ],
      new AbortController().signal,
    );
    expect(res.content.split("\n")).toEqual(["alpha", "beta-modified", "extra-line", "gamma"]);
  });

  it("strips copied hash-only prefixes in replace_lines new_text", () => {
    const orig = ["alpha", "beta", "gamma"].join("\n");
    const start = `1:${computeLineHash(1, "alpha")}`;
    const end = `2:${computeLineHash(2, "beta")}`;
    const res = applyHashlineEdits(
      orig,
      [
        {
          replace_lines: {
            start_anchor: start,
            end_anchor: end,
            new_text: `${h("one")}|one\n${h("two")}|two`,
          },
        },
      ],
      new AbortController().signal,
    );
    expect(res.content.split("\n")).toEqual(["one", "two", "gamma"]);
  });

  it("keeps lookalike prefixes whose hash does not match the line (data, not a copy)", () => {
    const orig = ["alpha", "beta"].join("\n");
    const anchor = `2:${computeLineHash(2, "beta")}`;
    const res = applyHashlineEdits(orig, [
      { set_line: { anchor, new_text: "100|a2\n200|b2\n10:45|standup\n+ bullet" } },
    ]);
    expect(res.content.split("\n")).toEqual([
      "alpha",
      "100|a2",
      "200|b2",
      "10:45|standup",
      "+ bullet",
    ]);
  });

  it("preserves a single legitimate pipe-prefixed line (no false-positive strip)", () => {
    const orig = ["alpha", "beta", "gamma"].join("\n");
    const anchor = `2:${computeLineHash(2, "beta")}`;
    const res = applyHashlineEdits(
      orig,
      [{ set_line: { anchor, new_text: "abc|payload" } }],
      new AbortController().signal,
    );
    expect(res.content.split("\n")).toEqual(["alpha", "abc|payload", "gamma"]);
  });
});
