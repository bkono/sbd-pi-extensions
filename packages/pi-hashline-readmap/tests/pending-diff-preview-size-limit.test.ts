import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPendingWritePreviewData } from "../src/pending-diff-preview.js";

describe("pending preview size limit", () => {
  it("skips proposed write content above the preview limit", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "pi-pending-size-limit-"));

    const huge = buildPendingWritePreviewData(
      { path: "huge.txt", content: "x".repeat(1024 * 1024 + 1) },
      cwd,
    );

    expect(huge.type).toBe("skip");
    if (huge.type !== "skip") throw new Error("oversized content unexpectedly projected");
    expect(huge.reason).toContain("large");
  });
});
