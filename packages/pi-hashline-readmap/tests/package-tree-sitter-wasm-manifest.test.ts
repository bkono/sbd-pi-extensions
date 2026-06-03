import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);

const nativePackages = [
  "tree-sitter",
  "tree-sitter-c",
  "tree-sitter-cpp",
  "tree-sitter-rust",
  "tree-sitter-java",
  "tree-sitter-clojure",
];

describe("tree-sitter WASM package manifest", () => {
  it("does not depend on native tree-sitter packages", () => {
    for (const name of nativePackages) {
      expect(packageJson.dependencies?.[name]).toBeUndefined();
    }
  });

  it("does not bundle native tree-sitter package directories", () => {
    const bundled = packageJson.bundledDependencies ?? [];
    const files = packageJson.files ?? [];
    for (const name of nativePackages) {
      expect(bundled).not.toContain(name);
      expect(files).not.toContain(`node_modules/${name}`);
    }
  });

  it("depends on supported web-tree-sitter 0.x and tree-sitter-wasms", () => {
    expect(packageJson.dependencies?.["web-tree-sitter"]).toMatch(/^\^?0\.(25|26)\./);
    expect(packageJson.dependencies?.["tree-sitter-wasms"]).toEqual(expect.any(String));
  });

  it("supports Node 20", () => {
    expect(packageJson.engines?.node).toBe(">=20.0.0");
  });
});
