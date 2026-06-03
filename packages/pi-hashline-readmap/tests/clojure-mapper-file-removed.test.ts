import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Clojure mapper file removal", () => {
  it("removes the Clojure mapper source file", () => {
    expect(
      existsSync(fileURLToPath(new URL("../src/readmap/mappers/clojure.ts", import.meta.url))),
    ).toBe(false);
  });
});
