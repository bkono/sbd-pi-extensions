import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPendingEditPreviewData } from "../src/pending-diff-preview.js";

function makeFixture(content: string): { cwd: string; filePath: string } {
  const cwd = mkdtempSync(resolve(tmpdir(), "pi-pending-replace-success-"));
  const filePath = resolve(cwd, "sample.ts");
  writeFileSync(filePath, content, "utf-8");
  return { cwd, filePath };
}

describe("pending edit replace preview", () => {
  it("projects an exact replace edit", async () => {
    const { cwd, filePath } = makeFixture("const value = 1;\nconst other = 2;\n");

    const projected = await buildPendingEditPreviewData(
      {
        path: filePath,
        edits: [{ replace: { old_text: "const value = 1;", new_text: "const value = 10;" } }],
      },
      cwd,
    );

    expect(projected.type).toBe("ok");
    if (projected.type !== "ok") throw new Error(projected.reason);
    expect(projected.data.headerLabel).toBe("pending edit");
    expect(projected.data.previousContent).toContain("const value = 1;");
    expect(projected.data.nextContent).toContain("const value = 10;");
    expect(projected.data.diff).toContain("-1 const value = 1;");
    expect(projected.data.diff).toContain("+1 const value = 10;");
  });
});
