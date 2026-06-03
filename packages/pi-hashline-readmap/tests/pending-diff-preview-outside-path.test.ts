import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPendingWritePreviewData } from "../src/pending-diff-preview.js";

describe("pending preview explicit absolute path", () => {
  it("projects an absolute existing-file write preview outside cwd", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "pi-pending-abs-write-cwd-"));
    const outsideDir = mkdtempSync(resolve(tmpdir(), "pi-pending-abs-write-outside-"));
    const outsideFile = resolve(outsideDir, "outside.txt");
    writeFileSync(outsideFile, "before\n", "utf-8");
    const realOutsideFile = realpathSync(outsideFile);

    const preview = buildPendingWritePreviewData({ path: outsideFile, content: "after\n" }, cwd);

    expect(preview.type).toBe("ok");
    if (preview.type !== "ok") throw new Error(`preview skipped: ${preview.reason}`);
    expect(preview.data.headerLabel).toBe("pending overwrite");
    expect(preview.data.filePath).toBe(realOutsideFile);
    expect(preview.data.previousContent).toBe("before\n");
    expect(preview.data.nextContent).toBe("after\n");
  });
});
