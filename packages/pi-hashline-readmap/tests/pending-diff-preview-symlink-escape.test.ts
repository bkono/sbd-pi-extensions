import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPendingWritePreviewData } from "../src/pending-diff-preview.js";

describe("pending preview symlink guard", () => {
  it("skips a symlink whose real path escapes cwd", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "pi-pending-symlink-cwd-"));
    const outsideDir = mkdtempSync(resolve(tmpdir(), "pi-pending-symlink-outside-"));
    const outsideFile = resolve(outsideDir, "outside.txt");
    writeFileSync(outsideFile, "outside\n", "utf-8");
    symlinkSync(outsideFile, resolve(cwd, "escape.txt"));

    const symlink = buildPendingWritePreviewData({ path: "escape.txt", content: "changed\n" }, cwd);

    expect(symlink.type).toBe("skip");
    if (symlink.type !== "skip") throw new Error("symlink escape unexpectedly projected");
    expect(symlink.reason).toContain("workspace");
  });
});
