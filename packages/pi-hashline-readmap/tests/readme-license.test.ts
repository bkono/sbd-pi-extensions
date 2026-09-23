import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

describe("LICENSE (AC-3)", () => {
  it("LICENSE file exists at project root", () => {
    expect(existsSync(resolve(root, "LICENSE"))).toBe(true);
  });

  it("contains MIT License text", () => {
    const license = readFileSync(resolve(root, "LICENSE"), "utf8");
    expect(license).toContain("MIT License");
  });

  it("contains copyright year", () => {
    const license = readFileSync(resolve(root, "LICENSE"), "utf8");
    expect(license).toContain("2026");
  });
});
