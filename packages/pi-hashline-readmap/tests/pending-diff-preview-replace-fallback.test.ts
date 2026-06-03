import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPendingEditPreviewData } from "../src/pending-diff-preview.js";

function makeFixture(content: string): { cwd: string; filePath: string } {
  const cwd = mkdtempSync(resolve(tmpdir(), "pi-pending-replace-first-"));
  const filePath = resolve(cwd, "sample.ts");
  writeFileSync(filePath, content, "utf-8");
  return { cwd, filePath };
}

describe("pending edit replace preview", () => {
  it("projects plain repeated replace as the first occurrence", async () => {
    const { cwd, filePath } = makeFixture("const one = 1;\nconst two = 2;\n");

    const preview = await buildPendingEditPreviewData(
      {
        path: filePath,
        edits: [{ replace: { old_text: "const", new_text: "let" } }],
      },
      cwd,
    );

    expect(preview.type).toBe("ok");
    if (preview.type !== "ok") throw new Error(`preview skipped: ${preview.reason}`);
    expect(preview.data.headerLabel).toBe("pending edit");
    expect(preview.data.nextContent).toBe("let one = 1;\nconst two = 2;\n");
  });
});
