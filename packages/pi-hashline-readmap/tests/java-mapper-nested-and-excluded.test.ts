import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SymbolKind } from "../src/readmap/enums.js";
import { javaMapper } from "../src/readmap/mappers/java.js";

const dirs: string[] = [];

async function writeJava(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-java-nested-"));
  dirs.push(dir);
  const file = join(dir, "Nested.java");
  await writeFile(file, source, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function child(parent: any, name: string) {
  return parent.children?.find((symbol: any) => symbol.name === name);
}

describe("javaMapper nested declarations and excluded nodes", () => {
  it("maps nested Java types as children and excludes annotations, local variables, and modifiers", async () => {
    const file = await writeJava(
      [
        "public class Outer {",
        "  @Deprecated",
        "  class InnerClass {}",
        "  interface InnerInterface {}",
        "  enum InnerEnum { ONE, TWO }",
        "  record InnerRecord(int id) {}",
        "  @interface InnerAnnotation {}",
        "  public String method() { int localValue = 1; return String.valueOf(localValue); }",
        "}",
        "",
      ].join("\n"),
    );

    const map = await javaMapper(file);
    expect(map).not.toBeNull();

    const outer = map!.symbols[0];
    expect(child(outer, "InnerClass")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Class, startLine: 2, endLine: 3 }),
    );
    expect(child(outer, "InnerInterface")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Interface }),
    );
    expect(child(outer, "InnerEnum")).toEqual(expect.objectContaining({ kind: SymbolKind.Enum }));
    expect(child(child(outer, "InnerEnum"), "ONE")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Constant }),
    );
    expect(child(child(outer, "InnerEnum"), "TWO")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Constant }),
    );
    expect(child(outer, "InnerRecord")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Class }),
    );
    expect(child(outer, "InnerAnnotation")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Interface }),
    );

    const names = JSON.stringify(
      map!.symbols.map((symbol) => [
        symbol.name,
        ...(symbol.children ?? []).map((child: any) => child.name),
      ]),
    );
    expect(names).not.toContain("Deprecated");
    expect(names).not.toContain("localValue");
    expect(names).not.toContain("modifiers");
  });
});
