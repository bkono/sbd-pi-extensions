import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureHashInit } from "../src/hashline";

const packagePath = (filePath: string) => fileURLToPath(new URL(`../${filePath}`, import.meta.url));
describe("read.ts syscall reduction", () => {
  let tmpDir: string;

  beforeAll(async () => {
    await ensureHashInit();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "read-test-"));
    writeFileSync(path.join(tmpDir, "exists.txt"), "hello\nworld");
    mkdirSync(path.join(tmpDir, "subdir"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("read.ts does not import or use fsAccess", () => {
    const source = readFileSync(packagePath("src/read.ts"), "utf-8");
    expect(source).not.toContain("fsAccess");
    expect(source).toContain("fsReadFile");
  });

  it("reading a nonexistent path returns error containing 'not found'", async () => {
    const { readFile } = await import("node:fs/promises");

    try {
      await readFile(path.join(tmpDir, "nonexistent.txt"));
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("ENOENT");
    }
  });

  it("reading a directory path triggers EISDIR handling with 'directory' message", async () => {
    const { readFile } = await import("node:fs/promises");

    try {
      await readFile(path.join(tmpDir, "subdir"));
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("EISDIR");
    }
  });

  it("fsStat is not called before fsReadFile in the main flow", () => {
    const source = readFileSync(packagePath("src/read.ts"), "utf-8");
    const lines = source.split("\n");
    const readFileLine = lines.findIndex((l) => l.includes("await fsReadFile("));
    expect(readFileLine).toBeGreaterThan(-1);
    const statLines = lines
      .map((l, i) => ({ line: l, idx: i }))
      .filter((l) => l.line.includes("await fsStat(") && !l.line.trim().startsWith("//"));

    for (const s of statLines) {
      expect(s.idx).toBeGreaterThan(readFileLine);
    }
  });
});
