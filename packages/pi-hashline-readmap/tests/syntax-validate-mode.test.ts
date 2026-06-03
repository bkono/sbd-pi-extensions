import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSyntaxValidateMode } from "../src/syntax-validate-mode.js";

const ENV = "PI_HASHLINE_SYNTAX_VALIDATE";

describe("resolveSyntaxValidateMode", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  });

  it("defaults to warn when no option and no env", () => {
    expect(resolveSyntaxValidateMode({})).toBe("warn");
  });

  it("uses option when provided", () => {
    expect(resolveSyntaxValidateMode({ syntaxValidate: "block" })).toBe("block");
    expect(resolveSyntaxValidateMode({ syntaxValidate: "off" })).toBe("off");
  });

  it("falls back to env when option absent", () => {
    process.env[ENV] = "block";
    expect(resolveSyntaxValidateMode({})).toBe("block");
  });

  it("option wins over env", () => {
    process.env[ENV] = "block";
    expect(resolveSyntaxValidateMode({ syntaxValidate: "off" })).toBe("off");
  });

  it("invalid option values fall back to default warn", () => {
    expect(resolveSyntaxValidateMode({ syntaxValidate: "bogus" as any })).toBe("warn");
  });

  it("invalid env values fall back to default warn", () => {
    process.env[ENV] = "bogus";
    expect(resolveSyntaxValidateMode({})).toBe("warn");
  });
});
