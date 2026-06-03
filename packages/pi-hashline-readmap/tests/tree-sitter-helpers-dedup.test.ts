import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagePath = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

const mapperFiles = [
  "src/readmap/mappers/rust.ts",
  "src/readmap/mappers/cpp.ts",
  "src/readmap/mappers/java.ts",
] as const;

describe("tree-sitter helper extraction (#202)", () => {
  for (const rel of mapperFiles) {
    it(`${rel} no longer defines normalizeWhitespace/getNodeText/getLineRange locally`, () => {
      const src = readFileSync(packagePath(rel), "utf8");
      expect(src).not.toMatch(/function\s+normalizeWhitespace\s*\(/);
      expect(src).not.toMatch(/function\s+getNodeText\s*\(/);
      expect(src).not.toMatch(/function\s+getLineRange\s*\(/);
    });

    it(`${rel} imports from tree-sitter-helpers.js`, () => {
      const src = readFileSync(packagePath(rel), "utf8");
      expect(src).toContain("./tree-sitter-helpers.js");
    });
  }

  it("parser-loader.ts is unchanged by this refactor (no tree-sitter-helpers import)", () => {
    const src = readFileSync(packagePath("src/readmap/parser-loader.ts"), "utf8");
    expect(src).not.toContain("tree-sitter-helpers");
  });
});
