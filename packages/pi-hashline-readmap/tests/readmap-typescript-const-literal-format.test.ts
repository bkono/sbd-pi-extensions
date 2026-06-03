import { describe, expect, it } from "vitest";
import { DetailLevel } from "../src/readmap/enums.js";
import { formatFileMap } from "../src/readmap/formatter.js";
import { typescriptMapperFromContent } from "../src/readmap/mappers/typescript.js";

describe("readmap formats exported const literal initializers cleanly (#169)", () => {
  it("does not glue numeric / boolean / string / null literals onto the symbol name", async () => {
    const content = [
      "export const value = 3;",
      "export const flag = true;",
      'export const name = "hello";',
      "export const ptr = null;",
      "export function add(a: number, b: number): number { return a + b; }",
      "",
    ].join("\n");

    const fm = await typescriptMapperFromContent("virtual.ts", content);
    expect(fm).not.toBeNull();

    const out = formatFileMap(fm!, DetailLevel.Full);

    // Negative: no glued literal next to the identifier
    expect(out).not.toMatch(/\bvalue3\b/);
    expect(out).not.toMatch(/\bflagtrue\b/);
    expect(out).not.toMatch(/name"hello"/);
    expect(out).not.toMatch(/\bptrnull\b/);

    // Positive: identifier renders intact, with `export` modifier, in the
    // variable form "<name> = ... [<lineRange>]" produced by the formatter.
    expect(out).toMatch(/export value = \.\.\. \[1\]/);
    expect(out).toMatch(/export flag = \.\.\. \[2\]/);
    expect(out).toMatch(/export name = \.\.\. \[3\]/);
    expect(out).toMatch(/export ptr = \.\.\. \[4\]/);

    // Functions stay untouched (regression guard).
    expect(out).toMatch(/add\(a: number, b: number\): number: \[5\]/);
  });
});
