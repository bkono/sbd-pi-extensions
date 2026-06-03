import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPendingEditPreviewData } from "../src/pending-diff-preview.js";

describe("pending replace_symbol edit preview", () => {
  it("projects a resolved symbol replacement", async () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "pi-pending-symbol-success-"));
    const filePath = resolve(cwd, "sample.ts");
    writeFileSync(
      filePath,
      "export function add(a: number, b: number) {\n  return a + b;\n}\n",
      "utf-8",
    );

    const projected = await buildPendingEditPreviewData(
      {
        path: filePath,
        edits: [
          {
            replace_symbol: {
              symbol: "add",
              new_body: "export function add(a: number, b: number) {\n  return a + b + 1;\n}",
            },
          },
        ],
      },
      cwd,
    );

    expect(projected.type).toBe("ok");
    if (projected.type !== "ok") throw new Error(projected.reason);
    expect(projected.data.headerLabel).toBe("pending edit");
    expect(projected.data.nextContent).toContain("return a + b + 1;");
    expect(projected.data.diff).toContain("-2   return a + b;");
    expect(projected.data.diff).toContain("+2   return a + b + 1;");
  });
});
