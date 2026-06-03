import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPendingWritePreviewData } from "../src/pending-diff-preview.js";

function makeDir(): string {
  return mkdtempSync(resolve(tmpdir(), "pi-pending-write-overwrite-"));
}

describe("pending write overwrite preview", () => {
  it("projects an existing-file overwrite preview", () => {
    const cwd = makeDir();
    const existingPath = resolve(cwd, "sample.txt");
    writeFileSync(existingPath, "old value\n", "utf-8");

    const overwrite = buildPendingWritePreviewData(
      { path: "sample.txt", content: "new value\n" },
      cwd,
    );

    expect(overwrite.type).toBe("ok");
    if (overwrite.type !== "ok") throw new Error(overwrite.reason);
    expect(overwrite.data.headerLabel).toBe("pending overwrite");
    expect(overwrite.data.fileExistedBeforeWrite).toBe(true);
    expect(overwrite.data.previousContent).toBe("old value\n");
    expect(overwrite.data.nextContent).toBe("new value\n");
    expect(overwrite.data.diff).toContain("-1 old value");
    expect(overwrite.data.diff).toContain("+1 new value");
  });
});
