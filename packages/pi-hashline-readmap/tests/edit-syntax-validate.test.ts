import { describe, expect, it } from "vitest";
import { validateSyntaxRegression } from "../src/edit-syntax-validate.js";

describe("validateSyntaxRegression (Rust)", () => {
  it("returns null when after-content is well-formed Rust", async () => {
    const before = "fn a() { 1 }\n";
    const after = "fn a() { 2 }\n";
    const r = await validateSyntaxRegression({ filePath: "x.rs", before, after });
    expect(r).toBeNull();
  });

  it("returns regression info when after-content adds new syntax errors", async () => {
    const before = "fn a() { 1 }\n";
    const after = "fn a( {\nfn b(\n";
    const r = await validateSyntaxRegression({ filePath: "x.rs", before, after });
    expect(r).not.toBeNull();
    expect(r!.errorLines.length).toBeGreaterThan(0);
    expect(r!.errorLines[0]).toMatch(/^\d+(-\d+)?$/);
  });

  it("treats undefined `before` as zero pre-existing errors", async () => {
    const after = "fn a( {\nfn b(\n";
    const r = await validateSyntaxRegression({
      filePath: "x.rs",
      before: undefined as unknown as string,
      after,
    });
    expect(r).not.toBeNull();
    expect(r!.errorLines.length).toBeGreaterThan(0);
  });
});

describe("validateSyntaxRegression unsupported languages", () => {
  it("returns null for python (mapped lang but no tree-sitter parser)", async () => {
    const r = await validateSyntaxRegression({
      filePath: "x.py",
      before: "def f():\n    return 1\n",
      after: "def f(:\n  broken\n",
    });
    expect(r).toBeNull();
  });

  it("returns null for unknown extension", async () => {
    const r = await validateSyntaxRegression({
      filePath: "weird.xyz",
      before: "anything",
      after: "anything else",
    });
    expect(r).toBeNull();
  });
});
