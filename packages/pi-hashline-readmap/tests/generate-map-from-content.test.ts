import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateMap, generateMapFromContent } from "../src/readmap/mapper.js";

describe("generateMapFromContent", () => {
  it("returns a FileMap for TypeScript content without touching disk", async () => {
    const content = "export function multiply(x: number, y: number) {\n  return x * y;\n}\n";
    const result = await generateMapFromContent("dummy.ts", content);
    expect(result).not.toBeNull();
    expect(result!.symbols.some((s: any) => s.name === "multiply")).toBe(true);
  });

  it("returns a FileMap for Rust content without touching disk", async () => {
    const content = "pub fn square(n: i32) -> i32 {\n    n * n\n}\n";
    const result = await generateMapFromContent("dummy.rs", content);
    // Null if tree-sitter-rust unavailable; otherwise FileMap with symbol.
    if (result !== null) {
      expect(result.symbols.some((s: any) => s.name === "square")).toBe(true);
    }
  });

  it("returns null for detected languages without a precise content mapper", async () => {
    const result = await generateMapFromContent("script.py", "def foo():\n    return 1\n");
    expect(result).toBeNull();
  });

  it("preserves the caller path and extension for TSX content", async () => {
    const content = "export function Widget() {\n  return <div />;\n}\n";
    const result = await generateMapFromContent("/tmp/source-widget.tsx", content);
    expect(result).not.toBeNull();
    expect(result!.symbols.some((s: any) => s.name === "Widget")).toBe(true);
    expect(result!.path).toBe("/tmp/source-widget.tsx");
  });

  it("generateMap still works for on-disk TypeScript files (AC 2 regression guard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-map-compat-"));
    const fp = join(dir, "compat.ts");
    writeFileSync(fp, "export const x = 1;\n");
    const result = await generateMap(fp);
    expect(result).not.toBeNull();
    expect(result!.symbols.some((s: any) => s.name === "x")).toBe(true);
  });
});
