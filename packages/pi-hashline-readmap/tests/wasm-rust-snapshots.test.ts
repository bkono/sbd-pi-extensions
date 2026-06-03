import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rustMapperFromContent } from "../src/readmap/mappers/rust.js";
import type { FileMap } from "../src/readmap/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function stable(map: FileMap): FileMap {
  return { ...map, path: basename(map.path) };
}

const cases = [
  ["simple", "wasm-rust-simple.rs"],
  ["nested", "wasm-rust-nested.rs"],
  ["generic", "wasm-rust-generic.rs"],
  ["representative", "wasm-rust-representative.rs"],
] as const;

describe("Rust WASM mapper snapshots", () => {
  for (const [name, fileName] of cases) {
    it(`maps ${name} Rust definitions`, async () => {
      const fixture = resolve(__dirname, "fixtures", fileName);
      const content = await readFile(fixture, "utf8");
      const map = await rustMapperFromContent(fixture, content);
      expect(map).not.toBeNull();
      expect(stable(map!)).toMatchSnapshot();
    });
  }
});
