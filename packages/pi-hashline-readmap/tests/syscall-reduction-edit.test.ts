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

  it("source handles ENOENT with 'not found' message", () => {
    const source = readFileSync(packagePath("src/edit.ts"), "utf-8");
    const enoentIdx = source.indexOf('"ENOENT"');
    expect(enoentIdx).toBeGreaterThan(-1);
    const nearbyBlock = source.slice(enoentIdx, enoentIdx + 200).toLowerCase();
    expect(nearbyBlock).toContain("not found");
  });

  it("source handles EISDIR with 'directory' message", () => {
    const source = readFileSync(packagePath("src/edit.ts"), "utf-8");
    const eisdirIdx = source.indexOf('"EISDIR"');
    expect(eisdirIdx).toBeGreaterThan(-1);
    const nearbyBlock = source.slice(eisdirIdx, eisdirIdx + 200).toLowerCase();
    expect(nearbyBlock).toContain("directory");
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
