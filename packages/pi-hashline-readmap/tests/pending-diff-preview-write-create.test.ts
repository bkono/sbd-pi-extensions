import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPendingWritePreviewData } from "../src/pending-diff-preview.js";

function makeDir(): string {
  return mkdtempSync(resolve(tmpdir(), "pi-pending-write-create-"));
}

describe("pending write create preview", () => {
  it("projects a missing-file create preview", () => {
    const cwd = makeDir();

    const created = buildPendingWritePreviewData(
      { path: "created.txt", content: "created value\n" },
      cwd,
    );

    expect(created.type).toBe("ok");
    if (created.type !== "ok") throw new Error(created.reason);
    expect(created.data.headerLabel).toBe("pending create");
    expect(created.data.fileExistedBeforeWrite).toBe(false);
    expect(created.data.previousContent).toBe("");
    expect(created.data.nextContent).toBe("created value\n");
    expect(created.data.diff).toContain("+1 created value");
  });
});
