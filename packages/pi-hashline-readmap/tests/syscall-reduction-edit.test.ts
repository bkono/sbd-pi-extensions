import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureHashInit } from "../src/hashline";

const packagePath = (filePath: string) => fileURLToPath(new URL(`../${filePath}`, import.meta.url));
describe("edit.ts syscall reduction", () => {
  beforeAll(async () => {
    await ensureHashInit();
  });

  it("edit.ts does not import or use fsAccess", () => {
    const source = readFileSync(packagePath("src/edit.ts"), "utf-8");
    expect(source).not.toContain("fsAccess");
    expect(source).toContain("fsReadFile");
  });

  it("edit.ts does not import constants from fs", () => {
    const source = readFileSync(packagePath("src/edit.ts"), "utf-8");
    expect(source).not.toContain("constants");
  });

  it("fsReadFile throws ENOENT for nonexistent path", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "edit-test-"));

    try {
      await readFile(path.join(tmpDir, "nonexistent.txt"));
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("ENOENT");
    }
  });
});
