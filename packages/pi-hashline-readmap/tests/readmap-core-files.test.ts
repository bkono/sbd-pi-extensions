import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest"; // AC10

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

describe("read-map core files (AC10)", () => {
  const required = [
    "src/readmap/mapper.ts",
    "src/readmap/formatter.ts",
    "src/readmap/language-detect.ts",
    "src/readmap/types.ts",
    "src/readmap/constants.ts",
  ];

  for (const file of required) {
    it(`${file} exists`, () => {
      expect(existsSync(resolve(root, file))).toBe(true);
    });
  }
});
