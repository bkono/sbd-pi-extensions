import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SymbolKind } from "../src/readmap/enums.js";
import { javaMapper } from "../src/readmap/mappers/java.js";

const dirs: string[] = [];

async function writeJava(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-java-declarators-"));
  dirs.push(dir);
  const file = join(dir, "Declarators.java");
  await writeFile(file, source, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function child(parent: any, name: string) {
  return parent.children?.find((symbol: any) => symbol.name === name);
}

describe("javaMapper fields, constants, and enum constants", () => {
  it("maps multi-declarator fields, constants, and enum constants as separate symbols", async () => {
    const file = await writeJava(
      [
        "public class Declarators {",
        "  private int x, y, z;",
        '  public static final String A = "a", B = "b";',
        "}",
        'interface Constants { String IA = "ia", IB = "ib"; }',
        "enum Color { RED, GREEN; }",
        "",
      ].join("\n"),
    );

    const map = await javaMapper(file);
    expect(map).not.toBeNull();

    const declarators = map!.symbols.find((symbol) => symbol.name === "Declarators")!;
    expect(child(declarators, "x")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Property, startLine: 2, endLine: 2 }),
    );
    expect(child(declarators, "y")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Property, startLine: 2, endLine: 2 }),
    );
    expect(child(declarators, "z")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Property, startLine: 2, endLine: 2 }),
    );
    expect(child(declarators, "A")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Constant, startLine: 3, endLine: 3 }),
    );
    expect(child(declarators, "B")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Constant, startLine: 3, endLine: 3 }),
    );
    expect(child(declarators, "x")).toEqual(
      expect.objectContaining({ modifiers: ["private"], isExported: false }),
    );
    expect(child(declarators, "A")).toEqual(
      expect.objectContaining({ modifiers: ["public", "static", "final"], isExported: true }),
    );

    const constants = map!.symbols.find((symbol) => symbol.name === "Constants")!;
    expect(child(constants, "IA")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Constant, startLine: 5, endLine: 5 }),
    );
    expect(child(constants, "IB")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Constant, startLine: 5, endLine: 5 }),
    );

    const color = map!.symbols.find((symbol) => symbol.name === "Color")!;
    expect(child(color, "RED")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Constant, startLine: 6, endLine: 6 }),
    );
    expect(child(color, "GREEN")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Constant, startLine: 6, endLine: 6 }),
    );
  });
});
