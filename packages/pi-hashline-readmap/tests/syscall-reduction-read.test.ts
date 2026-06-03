import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { mkdtemp } from "fs/promises";
import os from "os";
import path from "path";
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
    const { readFile } = await import("fs/promises");

    try {
      await readFile(path.join(tmpDir, "nonexistent.txt"));
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("ENOENT");
    }

    const source = readFileSync(packagePath("src/read.ts"), "utf-8");
    const enoentIdx = source.indexOf('"ENOENT"');
    expect(enoentIdx).toBeGreaterThan(-1);
    const nearbyBlock = source.slice(enoentIdx, enoentIdx + 200).toLowerCase();
    expect(nearbyBlock).toContain("not found");
  });

  it("reading a directory path triggers EISDIR handling with 'directory' message", async () => {
    const { readFile } = await import("fs/promises");

    try {
      await readFile(path.join(tmpDir, "subdir"));
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("EISDIR");
    }

    const source = readFileSync(packagePath("src/read.ts"), "utf-8");
    const eisdirIdx = source.indexOf('"EISDIR"');
    expect(eisdirIdx).toBeGreaterThan(-1);
    const nearbyBlock = source.slice(eisdirIdx, eisdirIdx + 200).toLowerCase();
    expect(nearbyBlock).toContain("directory");
  });

  it("source handles EACCES with 'permission' or 'access' message", () => {
    const source = readFileSync(packagePath("src/read.ts"), "utf-8");
    expect(source).toContain('"EACCES"');
    const eaccesIdx = source.indexOf('"EACCES"');
    const nearbyBlock = source.slice(eaccesIdx, eaccesIdx + 300).toLowerCase();
    expect(nearbyBlock).toMatch(/permission|access/);
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
