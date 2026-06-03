import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest"; // AC14

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

describe("outline scripts (AC14)", () => {
  it("scripts/python_outline.py exists", () => {
    expect(existsSync(resolve(root, "scripts/python_outline.py"))).toBe(true);
  });

  it("scripts/go_outline.go exists", () => {
    expect(existsSync(resolve(root, "scripts/go_outline.go"))).toBe(true);
  });
});
