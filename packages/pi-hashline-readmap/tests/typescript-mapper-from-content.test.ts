import { describe, expect, it } from "vitest";
import { typescriptMapperFromContent } from "../src/readmap/mappers/typescript.js";

describe("typescriptMapperFromContent", () => {
  it("returns a FileMap from in-memory TypeScript content without disk I/O", async () => {
    const content = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
    const result = await typescriptMapperFromContent("virtual.ts", content);
    expect(result).not.toBeNull();
    expect(result!.symbols.some((s: any) => s.name === "add")).toBe(true);
    expect(result!.path).toBe("virtual.ts");
    expect(result!.totalLines).toBe(4); // 3 lines + trailing newline → 4 split entries
  });

  it("returns a FileMap for JavaScript content when given a .js extension", async () => {
    const content = "function greet(name) {\n  return 'Hello, ' + name;\n}\n";
    const result = await typescriptMapperFromContent("util.js", content);
    expect(result).not.toBeNull();
    expect(result!.symbols.some((s: any) => s.name === "greet")).toBe(true);
  });
});
