import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const packagePath = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

function rootNode() {
  return {
    type: "source_file",
    namedChildren: [],
    namedChildCount: 0,
    childCount: 0,
    child: vi.fn(() => null),
    namedChild: vi.fn(() => null),
    childForFieldName: vi.fn(() => null),
    startIndex: 0,
    endIndex: 0,
    startPosition: { row: 0 },
    endPosition: { row: 0 },
    isMissing: false,
    isNamed: true,
  };
}

describe("edit syntax validator WASM lifecycle", () => {
  it("uses the shared WASM loader and deletes parser and trees", async () => {
    vi.resetModules();
    const deleteBeforeTree = vi.fn();
    const deleteAfterTree = vi.fn();
    const deleteParser = vi.fn();
    const parser = {
      parse: vi
        .fn()
        .mockReturnValueOnce({ rootNode: rootNode(), delete: deleteBeforeTree })
        .mockReturnValueOnce({ rootNode: rootNode(), delete: deleteAfterTree }),
      delete: deleteParser,
    };
    vi.doMock("../src/readmap/parser-loader.js", () => ({
      getWasmParser: vi.fn(async () => parser),
    }));
    const { validateSyntaxRegression } = await import("../src/edit-syntax-validate.js");
    await expect(
      validateSyntaxRegression({
        filePath: "sample.rs",
        before: "fn a() { 1 }\n",
        after: "fn a() { 2 }\n",
      }),
    ).resolves.toBeNull();
    expect(parser.parse).toHaveBeenCalledTimes(2);
    expect(deleteBeforeTree).toHaveBeenCalledTimes(1);
    expect(deleteAfterTree).toHaveBeenCalledTimes(1);
    expect(deleteParser).toHaveBeenCalledTimes(1);
    const source = readFileSync(packagePath("src/edit-syntax-validate.ts"), "utf8");
    expect(source).not.toContain("tree-sitter-rust");
    expect(source).not.toContain("tree-sitter-cpp");
    expect(source).not.toContain("tree-sitter-java");
    expect(source).not.toContain("tree-sitter-clojure");
    expect(source).not.toContain("ensureWritableTypeProperty");
  });
});
