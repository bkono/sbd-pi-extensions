import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  delete process.env.PI_HASHLINE_READMAP_DEBUG;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("edit syntax validation parser failure safety", () => {
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
    const { validateSyntaxRegression } = await import("../src/edit-syntax-validate.js");
    await expect(
      validateSyntaxRegression({ filePath: "bad.rs", before: "fn a() {}\n", after: "fn a() {}\n" }),
    ).resolves.toBeNull();
    expect(parser.delete).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "[hashline-readmap]",
    );
  });
});
