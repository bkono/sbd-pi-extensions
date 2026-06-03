import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateSyntaxRegression } from "../src/edit-syntax-validate.js";
import {
  detectLanguage,
  getSupportedExtensions,
  isSupported,
} from "../src/readmap/language-detect.js";
import { generateMapWithIdentity } from "../src/readmap/mapper.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Clojure-family fallback", () => {
  it("does not detect Clojure-family extensions as supported languages", () => {
    for (const ext of [".clj", ".cljs", ".cljc", ".edn"]) {
      expect(detectLanguage(`sample${ext}`)).toBeNull();
      expect(isSupported(`sample${ext}`)).toBe(false);
      expect(getSupportedExtensions()).not.toContain(ext);
    }
  });

  it("falls back normally for .clj files without syntax validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-clojure-fallback-"));
    dirs.push(dir);
    const file = join(dir, "sample.clj");
    await writeFile(file, "(defn hello [] :ok)\n", "utf8");
    const identity = await generateMapWithIdentity(file);
    expect(["ctags", "fallback"]).toContain(identity.mapperName);
    await expect(
      validateSyntaxRegression({
        filePath: file,
        before: "(defn hello [] :ok)\n",
        after: "(defn hello [\n",
      }),
    ).resolves.toBeNull();
  });
});
