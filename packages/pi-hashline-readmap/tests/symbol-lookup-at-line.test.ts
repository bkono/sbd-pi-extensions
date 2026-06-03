import { describe, expect, it } from "vitest";
import { findSymbol } from "../src/readmap/symbol-lookup.js";
import type { FileMap } from "../src/readmap/types.js";

const map: FileMap = {
  path: "x.ts",
  totalLines: 100,
  totalBytes: 1000,
  language: "TypeScript",
  symbols: [
    { name: "Override", kind: "function" as any, startLine: 10, endLine: 12 },
    {
      name: "Foo",
      kind: "class" as any,
      startLine: 1,
      endLine: 50,
      children: [
        { name: "bar", kind: "method" as any, startLine: 5, endLine: 8 },
        { name: "bar", kind: "method" as any, startLine: 30, endLine: 40 },
      ],
    },
  ],
  imports: [],
  detailLevel: "full" as any,
};

describe("findSymbol @line grammar", () => {
  it("does not trigger @line mode for `@Override`", () => {
    const r = findSymbol(map, "@Override");
    expect(r.type).toBe("not-found");
  });

  it("does not trigger @line for `foo@bar`", () => {
    const r = findSymbol(map, "foo@bar");
    expect(r.type).toBe("not-found");
  });

  it("does not trigger @line for `foo@1bar` (digits not at end-of-string)", () => {
    const r = findSymbol(map, "foo@1bar");
    expect(r.type).toBe("not-found");
  });

  it("without @line, returns ambiguous when multiple candidates share the name", () => {
    const r = findSymbol(map, "bar");
    expect(r.type).toBe("ambiguous");
    expect((r as any).candidates).toHaveLength(2);
    expect((r as any).candidates[0].startLine).toBe(5);
    expect((r as any).candidates[1].startLine).toBe(30);
  });

  it("resolves Foo.bar@7 to the overload at startLine 5 (containing range)", () => {
    const r = findSymbol(map, "Foo.bar@7");
    expect(r.type).toBe("found");
    expect((r as any).symbol.startLine).toBe(5);
  });

  it("resolves Foo.bar@35 to the overload at startLine 30 (containing range)", () => {
    const r = findSymbol(map, "Foo.bar@35");
    expect(r.type).toBe("found");
    expect((r as any).symbol.startLine).toBe(30);
  });

  it("resolves Foo.bar@20 to startLine 30 (nearest at-or-below)", () => {
    const r = findSymbol(map, "Foo.bar@20");
    expect(r.type).toBe("found");
    expect((r as any).symbol.startLine).toBe(30);
  });

  it("resolves Foo.bar@99 to startLine 30 (nearest above when none at-or-below)", () => {
    const r = findSymbol(map, "Foo.bar@99");
    expect(r.type).toBe("found");
    expect((r as any).symbol.startLine).toBe(30);
  });

  it("@line not-found for an unknown leaf name returns plain not-found (no candidates field)", () => {
    const r = findSymbol(map, "missing@10");
    expect(r.type).toBe("not-found");
    expect((r as any).candidates ?? []).toEqual([]);
  });

  it("@line not-found for a known dotted path with only no-startLine candidates lists same-name decls", () => {
    const m: FileMap = {
      ...map,
      symbols: [
        {
          name: "Foo",
          kind: "class" as any,
          startLine: 1,
          endLine: 50,
          children: [{ name: "baz", kind: "method" as any, startLine: 0, endLine: 0 }],
        },
        { name: "baz", kind: "function" as any, startLine: 80, endLine: 90 },
      ],
    };
    const r = findSymbol(m, "Foo.baz@5");
    expect(r.type).toBe("not-found");
    expect((r as any).message).toContain("Candidates: ");
    expect((r as any).message).toMatch(/baz@\d+/);
    expect(((r as any).candidates ?? []).length).toBeGreaterThan(0);
    expect((r as any).candidates.some((c: any) => c.name === "baz" && c.startLine === 80)).toBe(
      true,
    );
  });
});
