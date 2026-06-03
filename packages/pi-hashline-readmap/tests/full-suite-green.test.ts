import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

describe("M1.5 deliverables complete (AC-6)", () => {
  it("all required project files exist", () => {
    const requiredFiles = [
      "README.md",
      "LICENSE",
      "package.json",
      "index.ts",
      "tsconfig.json",
      "vitest.config.ts",
      "prompts/read.md",
      "prompts/edit.md",
    ];
    for (const file of requiredFiles) {
      expect(existsSync(resolve(root, file)), `${file} should exist`).toBe(true);
    }
  });
});
