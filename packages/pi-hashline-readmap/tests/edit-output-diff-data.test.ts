import { describe, expect, it } from "vitest";
import type { DiffData } from "../src/diff-data.js";
import { buildEditOutput } from "../src/edit-output.js";

describe("buildEditOutput diffData", () => {
  it("projects diffData into edit ptcValue without changing existing diff fields", () => {
    const diffData: DiffData = {
      version: 1,
      entries: [
        { kind: "remove", oldLine: 1, text: "const value = 1;" },
        { kind: "add", newLine: 1, text: "const value = 2;" },
      ],
      stats: { added: 1, removed: 1, context: 0 },
      language: "typescript",
    };

    const result = buildEditOutput({
      path: "/tmp/sample.ts",
      displayPath: "sample.ts",
      diff: "1:abc|const value = 1; → 1:def|const value = 2;",
      diffData,
      firstChangedLine: 1,
      warnings: [],
      noopEdits: [],
      edits: [{ set_line: { anchor: "1:abc", new_text: "const value = 2;" } }],
    });

    expect(result.ptcValue.diff).toBe("1:abc|const value = 1; → 1:def|const value = 2;");
    expect(result.ptcValue.firstChangedLine).toBe(1);
    expect(result.ptcValue.diffData).toEqual(diffData);
  });
});
