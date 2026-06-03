import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cppMapper } from "../src/readmap/mappers/cpp.js";
import type { FileMap } from "../src/readmap/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function stable(map: FileMap): FileMap {
  return { ...map, path: basename(map.path) };
}

const cases = [
  ["simple", "wasm-cpp-simple.cpp"],
  ["nested", "wasm-cpp-nested.cpp"],
  ["generic", "wasm-cpp-generic.cpp"],
  ["representative", "wasm-cpp-representative.cpp"],
] as const;

describe("C++ WASM mapper snapshots", () => {
  for (const [name, fileName] of cases) {
    it(`maps ${name} C++ definitions`, async () => {
      const fixture = resolve(__dirname, "fixtures", fileName);
      const map = await cppMapper(fixture);
      expect(map).not.toBeNull();
      expect(stable(map!)).toMatchSnapshot();
    });
  }
});
