import { afterEach, describe, expect, it, vi } from "vitest";

describe("parser error reporter", () => {
  afterEach(() => {
    delete process.env.PI_HASHLINE_READMAP_DEBUG;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("is silent when PI_HASHLINE_READMAP_DEBUG is unset", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { reportParserError, __resetParserErrorReporterForTests } = await import(
      "../src/readmap/parser-errors.js"
    );
    __resetParserErrorReporterForTests();
    reportParserError("load:rust", new Error("boom"), { context: "failed rust" });
    expect(error).not.toHaveBeenCalled();
  });

  it("emits one prefixed error per onceKey when debug is enabled", async () => {
    process.env.PI_HASHLINE_READMAP_DEBUG = "1";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { reportParserError, __resetParserErrorReporterForTests } = await import(
      "../src/readmap/parser-errors.js"
    );
    __resetParserErrorReporterForTests();
    reportParserError("load:rust", new Error("boom"), { context: "failed rust" });
    reportParserError("load:rust", new Error("boom again"), { context: "failed rust" });
    reportParserError("load:java", "plain", { context: "failed java" });
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("[hashline-readmap] failed rust: boom");
    expect(String(error.mock.calls[1]?.[0])).toContain("[hashline-readmap] failed java: plain");
  });
});
