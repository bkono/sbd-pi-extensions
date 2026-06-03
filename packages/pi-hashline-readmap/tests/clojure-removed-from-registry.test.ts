import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagePath = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

describe("Clojure registry removal", () => {
  it("removes Clojure from mapper registries and version tests", () => {
    const mapper = readFileSync(packagePath("src/readmap/mapper.ts"), "utf8");
    const versions = readFileSync(packagePath("tests/mapper-versions.test.ts"), "utf8");
    const syntax = readFileSync(packagePath("src/edit-syntax-validate.ts"), "utf8");
    expect(mapper).not.toMatch(/clojure/i);
    expect(versions).not.toMatch(/clojure/i);
    expect(syntax).not.toMatch(/clojure/i);
  });
});
