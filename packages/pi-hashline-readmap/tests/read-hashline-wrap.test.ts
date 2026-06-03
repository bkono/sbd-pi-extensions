import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { wrapReadHashlinesForWidth } from "../src/tui-render-utils.js";

const red = "\u001b[31m";
const reset = "\u001b[0m";

describe("wrapReadHashlinesForWidth", () => {
  it("wraps hashline content under the observed prefix", () => {
    const source =
      "99999:abcdef|export function veryLongName(argumentOne: string, argumentTwo: string): void {}";
    const rendered = wrapReadHashlinesForWidth(source, 48);
    const lines = rendered.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/^99999:abcdef\|export function/);
    expect(lines[1]).toMatch(/^ {13}/);
    expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
  });

  it("does not wrap non-content lines with the hashline continuation algorithm", () => {
    const header = "[Showing lines 1-2 of 2. Use offset=3 to continue.]";
    expect(wrapReadHashlinesForWidth(header, 20)).toBe(header);
  });

  it("is a no-op when wide enough", () => {
    const source = "1:abc|short";
    expect(wrapReadHashlinesForWidth(source, 80)).toBe(source);
  });

  it("preserves ANSI styling while respecting tabs and visible width", () => {
    const source = `12:abc|${red}const\tmessage = "hello hello hello hello";${reset}`;
    const rendered = wrapReadHashlinesForWidth(source, 30);
    expect(rendered).toContain(red);
    expect(rendered).toContain(reset);
    expect(rendered.split("\n").every((line) => visibleWidth(line) <= 30)).toBe(true);
  });
});
