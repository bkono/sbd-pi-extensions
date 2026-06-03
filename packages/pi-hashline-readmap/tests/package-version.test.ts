import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
const packageLock = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../package-lock.json", import.meta.url)), "utf8"),
);

describe("package version", () => {
  it("matches the SBD workspace lockfile entry", () => {
    expect(packageJson.version).toBe("0.1.0");
    expect(packageLock.packages["packages/pi-hashline-readmap"].version).toBe("0.1.0");
    expect(packageLock.packages["packages/pi-hashline-readmap"].name).toBe(
      "@solvedbydev/pi-hashline-readmap",
    );
  });

  it("points package-installed pi extension metadata at shipped dist output", () => {
    expect(packageJson.files).toContain("dist");
    expect(packageJson.pi.extensions).toEqual(["./dist/src/index.mjs"]);
  });
});
