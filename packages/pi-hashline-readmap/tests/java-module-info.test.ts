import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SymbolKind } from "../src/readmap/enums.js";
import { javaMapper } from "../src/readmap/mappers/java.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(__dirname, "fixtures/module-info.java");

describe("Java module-info mapping", () => {
  it("maps module_declaration as SymbolKind.Module", async () => {
    const direct = await javaMapper(fixture);

    expect(direct).not.toBeNull();
    expect(direct!.language).toBe("Java");
    expect(direct!.symbols).toEqual([
      expect.objectContaining({
        name: "com.example.navigation",
        kind: SymbolKind.Module,
        startLine: 1,
        endLine: 4,
        signature: "module com.example.navigation",
      }),
    ]);
  });
});
