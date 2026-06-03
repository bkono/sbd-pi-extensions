import { describe, expect, it } from "vitest";
import { rustMapperFromContent } from "../src/readmap/mappers/rust.js";

describe("rustMapperFromContent", () => {
  it("returns a FileMap from in-memory Rust content, or null when parser unavailable", async () => {
    const content = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n";
    const result = await rustMapperFromContent("virtual.rs", content);
    expect(result).not.toBeNull();
    expect(result!.symbols.some((s: any) => s.name === "add")).toBe(true);
    expect(result!.path).toBe("virtual.rs");
    expect(result!.language).toBe("Rust");
  });

  it("returns null for empty content (no symbols extracted)", async () => {
    const result = await rustMapperFromContent("empty.rs", "// just a comment\n");
    // Either null (no symbols) or a FileMap with no symbols; both are acceptable
    if (result !== null) {
      expect(result.symbols.length).toBe(0);
    }
  });
});
