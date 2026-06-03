import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const dirs: string[] = [];
afterEach(async () => {
  delete process.env.PI_HASHLINE_READMAP_DEBUG;
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("C++ WASM parser failure safety", () => {
  it("swallows parser corruption exceptions and reports in debug mode", async () => {
    process.env.PI_HASHLINE_READMAP_DEBUG = "1";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const parser = {
      parse: vi.fn(() => {
        throw new Error("simulated parser corruption");
      }),
      delete: vi.fn(),
    };
    vi.doMock("../src/readmap/parser-loader.js", () => ({
      getWasmParser: vi.fn(async () => parser),
    }));
    const { cppMapper } = await import("../src/readmap/mappers/cpp.js");
    const dir = await mkdtemp(join(tmpdir(), "pi-cpp-parser-failure-"));
    dirs.push(dir);
    const file = join(dir, "bad.cpp");
    await writeFile(file, "int main() {\n", "utf8");
    await expect(cppMapper(file)).resolves.toBeNull();
    expect(parser.delete).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "[hashline-readmap]",
    );
  });
});
