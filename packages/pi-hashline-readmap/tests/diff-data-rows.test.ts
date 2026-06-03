import { describe, expect, it } from "vitest";
import { buildDiffData } from "../src/diff-data.js";
import { generateDiffString } from "../src/edit-diff.js";

function countByKind(entries: Array<{ kind: string }>, kind: string): number {
  return entries.filter((entry) => entry.kind === kind).length;
}

describe("DiffData full diff rows", () => {
  it("builds versioned entries, stats, and language for full multi-line diffs", () => {
    const oldContent = [
      "const one = 1;",
      "const two = 2;",
      "const three = 3;",
      "const four = 4;",
    ].join("\n");
    const newContent = [
      "const one = 1;",
      "const two = 22;",
      "const three = 33;",
      "const four = 4;",
    ].join("\n");
    const diff = generateDiffString(oldContent, newContent).diff;

    const diffData = buildDiffData({ path: "sample.ts", oldContent, newContent, diff });

    expect(diffData.version).toBe(1);
    expect(diffData.language).toBe("typescript");
    expect(diffData.entries).toHaveLength(diff.split("\n").length);
    expect(
      diffData.entries.some(
        (entry) =>
          entry.kind === "context" &&
          entry.oldLine === 1 &&
          entry.newLine === 1 &&
          entry.text === "const one = 1;",
      ),
    ).toBe(true);
    expect(
      diffData.entries.some(
        (entry) =>
          entry.kind === "remove" && entry.oldLine === 2 && entry.text === "const two = 2;",
      ),
    ).toBe(true);
    expect(
      diffData.entries.some(
        (entry) => entry.kind === "add" && entry.newLine === 2 && entry.text === "const two = 22;",
      ),
    ).toBe(true);
    expect(diffData.stats).toEqual({
      added: countByKind(diffData.entries, "add"),
      removed: countByKind(diffData.entries, "remove"),
      context: countByKind(diffData.entries, "context"),
    });
  });

  it("keeps context newLine aligned after omitted leading context", () => {
    const oldLines = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`);
    const newLines = [...oldLines];
    newLines[99] = "line one hundred changed";
    const oldContent = oldLines.join("\n");
    const newContent = newLines.join("\n");
    const diff = generateDiffString(oldContent, newContent).diff;

    const diffData = buildDiffData({ path: "sample.ts", oldContent, newContent, diff });

    expect(diffData.entries).toContainEqual({ kind: "meta", text: "     ..." });
    expect(diffData.entries).toContainEqual({
      kind: "context",
      oldLine: 96,
      newLine: 96,
      text: "line 96",
    });
    expect(diffData.entries).toContainEqual({ kind: "remove", oldLine: 100, text: "line 100" });
    expect(diffData.entries).toContainEqual({
      kind: "add",
      newLine: 100,
      text: "line one hundred changed",
    });
  });

  it("omits language for unknown extensions", () => {
    const oldContent = "alpha\nbeta";
    const newContent = "alpha\nBETA";
    const diff = generateDiffString(oldContent, newContent).diff;

    const diffData = buildDiffData({ path: "sample.unknownext", oldContent, newContent, diff });

    expect(diffData.language).toBeUndefined();
  });
});
