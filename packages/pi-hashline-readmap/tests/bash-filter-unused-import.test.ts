import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagePath = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

describe("bash-filter imports", () => {
  it("does not keep an unused testOutput import", () => {
    const source = readFileSync(packagePath("src/rtk/bash-filter.ts"), "utf-8");
    expect(source).not.toContain('import * as testOutput from "./test-output.ts";');
  });
});
