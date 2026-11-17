import { beforeAll, describe, expect, it } from "vitest";
import {
  applyHashlineEdits,
  computeLineHash,
  ensureHashInit,
  HashlineOverlapError,
} from "../src/hashline.js";

describe("conflicting single-target edits", () => {
  beforeAll(async () => {
    await ensureHashInit();
  });

  it("refuses conflicting edits to the same line instead of silently keeping the last", () => {
    const content = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");
    const anchor = `2:${computeLineHash(2, "const b = 2;")}`;

    expect(() =>
      applyHashlineEdits(content, [
        { replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "const b = 20;" } },
        { replace_lines: { start_anchor: anchor, end_anchor: anchor, new_text: "const b = 200;" } },
      ]),
    ).toThrow(HashlineOverlapError);
  });

  it("still collapses identical duplicate edits", () => {
    const content = ["const a = 1;", "const b = 2;"].join("\n");
    const anchor = `2:${computeLineHash(2, "const b = 2;")}`;
    const result = applyHashlineEdits(content, [
      { set_line: { anchor, new_text: "const b = 20;" } },
      { set_line: { anchor, new_text: "const b = 20;" } },
    ]);
    expect(result.content).toBe(["const a = 1;", "const b = 20;"].join("\n"));
  });
});
