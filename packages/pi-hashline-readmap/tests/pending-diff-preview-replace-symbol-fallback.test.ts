import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPendingEditPreviewData } from "../src/pending-diff-preview.js";

describe("pending replace_symbol fallback", () => {
  it("skips an unresolved symbol", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "pi-pending-symbol-fallback-"));
    const filePath = resolve(cwd, "sample.ts");
    writeFileSync(
      filePath,
      "export function add(a: number, b: number) {\n  return a + b;\n}\n",
      "utf-8",
    );

    const missing = await buildPendingEditPreviewData(
      {
        path: filePath,
        edits: [
          {
            replace_symbol: {
              symbol: "missing",
              new_body: "export function missing() {\n  return 1;\n}",
            },
          },
        ],
      },
      cwd,
    );

    expect(missing.type).toBe("skip");
    if (missing.type !== "skip") throw new Error("missing symbol unexpectedly projected");
    expect(missing.reason).toContain("symbol projection failed");
  });
});
