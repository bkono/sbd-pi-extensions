import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rustMapperFromContent } from "../src/readmap/mappers/rust.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(__dirname, "fixtures/wasm-rust-representative.rs");
const MAX_RSS_GROWTH = 50 * 1024 * 1024;

describe("WASM parser parse-loop soak", () => {
  it("does not grow RSS by more than 50 MB after warmup", async () => {
    const content = await readFile(fixture, "utf8");
    for (let i = 0; i < 25; i += 1) {
      expect(await rustMapperFromContent(fixture, content)).not.toBeNull();
    }
    const postWarmupRss = process.memoryUsage().rss;
    for (let i = 0; i < 250; i += 1) {
      expect(await rustMapperFromContent(fixture, content)).not.toBeNull();
    }
    const finalRss = process.memoryUsage().rss;
    expect(finalRss - postWarmupRss).toBeLessThanOrEqual(MAX_RSS_GROWTH);
  });
});
