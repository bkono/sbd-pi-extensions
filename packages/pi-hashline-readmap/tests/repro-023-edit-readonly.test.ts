import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Bug #023: edit readonly file -> permission denied", () => {
  const tmpDir = join(__dirname, ".tmp-023");
  const readonlyFile = join(tmpDir, "readonly.txt");
  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(readonlyFile, "line1\nline2\nline3\n", "utf-8");
    chmodSync(readonlyFile, 0o444);
  });
  afterAll(() => {
    try {
      chmodSync(readonlyFile, 0o644);
    } catch {}
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {}
  });
  it("edit tool execute on chmod 444 file returns 'Permission denied: <path>'", async () => {
    const { registerEditTool } = await import("../src/edit.js");
    const { ensureHashInit, computeLineHash } = await import("../src/hashline.js");
    await ensureHashInit();
    let capturedTool: any = null;
    const mockPi = {
      registerTool(def: any) {
        capturedTool = def;
      },
    };
    registerEditTool(mockPi as any);
    if (!capturedTool) throw new Error("edit tool was not registered");

    const hash1 = computeLineHash(1, "line1");
    const result = await capturedTool.execute(
      "test-call",
      {
        path: readonlyFile,
        edits: [{ set_line: { anchor: `1:${hash1}`, new_text: "modified" } }],
      },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );
    expect(result.isError).toBe(true);
    expect(result.details.ptcValue.error.code).toBe("permission-denied");
  });
});
