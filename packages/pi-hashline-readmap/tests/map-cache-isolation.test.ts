import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagePath = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

describe("map-cache isolation", () => {
  it("src/map-cache.ts has no direct persistence fs calls", async () => {
    const src = await readFile(packagePath("src/map-cache.ts"), "utf-8");
    // Must not import fs.writeFile/readFile/readdir/rename/unlink/mkdir.
    const banned = ["writeFile", "readFile", "rename", "readdir", "unlink", "mkdir"];
    for (const name of banned) {
      expect(src).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    // Must still import stat (for mtime) — sanity check.
    expect(src).toMatch(/\bstat\b/);
    // Must import from ./persistent-map-cache.
    expect(src).toMatch(/from\s+["']\.\/persistent-map-cache(?:\.js)?["']/);
  });
});
