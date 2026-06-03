import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { javaMapperFromContent } from "../src/readmap/mappers/java.js";
import type { FileMap } from "../src/readmap/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function stable(map: FileMap): FileMap {
  return { ...map, path: basename(map.path) };
}

const cases = [
  ["simple", "wasm-java-simple.java"],
  ["nested", "wasm-java-nested.java"],
  ["generic", "wasm-java-generic.java"],
  ["representative", "wasm-java-representative.java"],
] as const;

describe("Java WASM mapper snapshots", () => {
  for (const [name, fileName] of cases) {
    it(`maps ${name} Java definitions`, async () => {
      const fixture = resolve(__dirname, "fixtures", fileName);
      const content = await readFile(fixture, "utf8");
      const map = await javaMapperFromContent(fixture, content);
      expect(map).not.toBeNull();
      expect(stable(map!)).toMatchSnapshot();
    });
  }
});
