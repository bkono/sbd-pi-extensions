import { describe, expect, it } from "vitest";
import { parseArgv, parseModelOverride } from "../../argv.js";

describe("argv parsing", () => {
  it("parses delegate model overrides as string options", () => {
    const parsed = parseArgv("delegate BW-101 --model cursor/composer-2");

    expect(parsed.positional).toEqual(["delegate", "BW-101"]);
    expect(parsed.options.get("model")).toBe("cursor/composer-2");
  });

  it("parses provider/model override values", () => {
    expect(parseModelOverride("cursor/composer-2")).toEqual({
      provider: "cursor",
      model: "composer-2",
    });
    expect(parseModelOverride("gpt-5.4")).toEqual({ model: "gpt-5.4" });
  });

  it("rejects malformed provider/model overrides", () => {
    expect(() => parseModelOverride("cursor/")).toThrow(
      "Invalid model override: cursor/. Expected provider/model or a bare model name.",
    );
    expect(() => parseModelOverride("")).toThrow("Model override cannot be empty.");
  });
});
