import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SymbolKind } from "../src/readmap/enums.js";
import { javaMapper } from "../src/readmap/mappers/java.js";

const dirs: string[] = [];

async function writeJava(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-java-types-"));
  dirs.push(dir);
  const file = join(dir, "Declarations.java");
  await writeFile(file, source, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("javaMapper top-level type declarations", () => {
  it("maps Java top-level class, interface, enum, record, and annotation declarations", async () => {
    const file = await writeJava(
      [
        "package com.example.nav;",
        "",
        "@Deprecated",
        "public class Declarations {",
        "}",
        "interface TopInterface {}",
        "enum TopEnum { RED }",
        "record TopRecord(String name) {}",
        "@interface TopAnnotation { String value(); }",
        "",
      ].join("\n"),
    );

    const map = await javaMapper(file);

    expect(map).not.toBeNull();
    expect(map!.symbols.map((symbol) => `${symbol.name}:${symbol.kind}`)).toEqual([
      `Declarations:${SymbolKind.Class}`,
      `TopInterface:${SymbolKind.Interface}`,
      `TopEnum:${SymbolKind.Enum}`,
      `TopRecord:${SymbolKind.Class}`,
      `TopAnnotation:${SymbolKind.Interface}`,
    ]);
    expect(map!.symbols[0]).toEqual(
      expect.objectContaining({
        name: "Declarations",
        kind: SymbolKind.Class,
        startLine: 3,
        endLine: 5,
        signature: "@Deprecated public class Declarations",
        modifiers: ["public"],
        isExported: true,
      }),
    );
  });
});
