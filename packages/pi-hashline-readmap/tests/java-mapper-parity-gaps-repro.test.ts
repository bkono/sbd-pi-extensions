import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SymbolKind } from "../src/readmap/enums.js";
import { javaMapper } from "../src/readmap/mappers/java.js";

const dirs: string[] = [];

async function writeJava(filename: string, source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-java-parity-"));
  dirs.push(dir);
  const file = join(dir, filename);
  await writeFile(file, source, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function child(parent: any, name: string) {
  return parent?.children?.find((symbol: any) => symbol.name === name);
}

describe("javaMapper parity gaps (REPRO — should fail until fixed)", () => {
  it("maps annotation_type_element_declaration members under @interface", async () => {
    const file = await writeJava(
      "MyAnno.java",
      ["public @interface MyAnno {", "  String value();", "  int count() default 1;", "}", ""].join(
        "\n",
      ),
    );

    const map = await javaMapper(file);
    expect(map).not.toBeNull();

    const anno = map!.symbols.find((s) => s.name === "MyAnno");
    expect(anno).toBeDefined();
    expect(anno!.kind).toBe(SymbolKind.Interface);

    expect(child(anno, "value")).toEqual(
      expect.objectContaining({
        kind: SymbolKind.Method,
      }),
    );
    expect(child(anno, "count")).toEqual(
      expect.objectContaining({
        kind: SymbolKind.Method,
      }),
    );
  });

  it("traverses class_body declarations under an enum_constant", async () => {
    const file = await writeJava(
      "Op.java",
      [
        "public enum Op {",
        "  PLUS {",
        "    @Override",
        "    public int apply(int a, int b) { return a + b; }",
        "    int helper() { return 0; }",
        "  },",
        "  MINUS;",
        "  public abstract int apply(int a, int b);",
        "}",
        "",
      ].join("\n"),
    );

    const map = await javaMapper(file);
    expect(map).not.toBeNull();

    const op = map!.symbols.find((s) => s.name === "Op")!;
    expect(op.kind).toBe(SymbolKind.Enum);

    const plus = child(op, "PLUS");
    expect(plus).toBeDefined();
    expect(plus.kind).toBe(SymbolKind.Constant);

    // Methods declared in PLUS's class body should be surfaced as children of PLUS.
    expect(child(plus, "apply")).toEqual(
      expect.objectContaining({
        kind: SymbolKind.Method,
      }),
    );
    expect(child(plus, "helper")).toEqual(
      expect.objectContaining({
        kind: SymbolKind.Method,
      }),
    );

    // The abstract method on the enum itself still maps.
    expect(child(op, "apply")).toEqual(
      expect.objectContaining({
        kind: SymbolKind.Method,
      }),
    ); // task 2 regression
  });
});
