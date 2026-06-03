import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagePath = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

function hasRuntimeSkip(path: string): boolean {
  return readFileSync(packagePath(path), "utf8").includes(
    'describe.skipIf(process.platform === "win32")',
  );
}

describe("quoted-path mapper tests on Windows", () => {
  it("skips the Go runtime fixture on win32", () => {
    expect(hasRuntimeSkip("tests/readmap-mappers-go-quoting.test.ts")).toBe(true);
  });

  it("skips the JSON runtime fixture on win32", () => {
    expect(hasRuntimeSkip("tests/readmap-mappers-json-quoting.test.ts")).toBe(true);
  });
  it("skips the ctags runtime fixture on win32", () => {
    expect(hasRuntimeSkip("tests/readmap-mappers-ctags-quoting.test.ts")).toBe(true);
  });
  it("skips the Python runtime fixture on win32", () => {
    expect(hasRuntimeSkip("tests/readmap-mappers-python-quoting.test.ts")).toBe(true);
  });
  it("skips the fallback runtime fixture on win32", () => {
    expect(hasRuntimeSkip("tests/readmap-mappers-fallback-quoting.test.ts")).toBe(true);
  });
});
