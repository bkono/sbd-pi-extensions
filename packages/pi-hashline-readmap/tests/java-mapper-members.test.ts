import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SymbolKind } from "../src/readmap/enums.js";
import { javaMapper } from "../src/readmap/mappers/java.js";

const dirs: string[] = [];

async function writeJava(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-java-members-"));
  dirs.push(dir);
  const file = join(dir, "Members.java");
  await writeFile(file, source, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function child(parent: any, name: string) {
  return parent.children?.find((symbol: any) => symbol.name === name);
}

describe("javaMapper member methods and initializers", () => {
  it("maps constructors, methods, compact constructors, and static initializers", async () => {
    const file = await writeJava(
      [
        "public class Members {",
        '  static { System.setProperty("ready", "true"); }',
        "  public Members() {}",
        "  @Override",
        "  public String toString() { int localValue = 1; return String.valueOf(localValue); }",
        "}",
        "record MemberRecord(int id) { MemberRecord { if (id < 0) throw new IllegalArgumentException(); } }",
        "",
      ].join("\n"),
    );

    const map = await javaMapper(file);
    expect(map).not.toBeNull();

    const members = map!.symbols.find((symbol) => symbol.name === "Members")!;
    expect(child(members, "<clinit>")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Method, startLine: 2, endLine: 2 }),
    );
    expect(child(members, "Members")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Method, startLine: 3, endLine: 3 }),
    );
    expect(child(members, "toString")).toEqual(
      expect.objectContaining({
        kind: SymbolKind.Method,
        startLine: 4,
        endLine: 5,
        signature: expect.stringContaining("public String toString()"),
      }),
    );

    const record = map!.symbols.find((symbol) => symbol.name === "MemberRecord")!;
    expect(child(record, "MemberRecord")).toEqual(
      expect.objectContaining({ kind: SymbolKind.Method, startLine: 7, endLine: 7 }),
    );

    const serialized = JSON.stringify(map!.symbols);
    expect(serialized).not.toContain("localValue");
  });
});
