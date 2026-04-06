import { describe, expect, it } from "vitest";
import { appendObservations } from "../../engine.js";

describe("appendObservations", () => {
	it("returns incoming when existing is empty", () => {
		expect(appendObservations("", "new obs")).toBe("new obs");
	});

	it("returns existing when incoming is empty", () => {
		expect(appendObservations("old obs", "")).toBe("old obs");
	});

	it("returns empty string when both are empty", () => {
		expect(appendObservations("", "")).toBe("");
	});

	it("returns single copy when strings are identical", () => {
		expect(appendObservations("same", "same")).toBe("same");
	});

	it("returns incoming when it contains existing as substring", () => {
		expect(appendObservations("a", "a and b")).toBe("a and b");
	});

	it("returns existing when it contains incoming as substring", () => {
		expect(appendObservations("a and b", "a")).toBe("a and b");
	});

	it("joins distinct strings with double newline", () => {
		expect(appendObservations("first", "second")).toBe("first\n\nsecond");
	});

	it("normalizes CRLF to LF", () => {
		const result = appendObservations("line1\r\nline2", "line3\r\nline4");
		expect(result).not.toContain("\r");
		expect(result).toContain("line1\nline2");
		expect(result).toContain("line3\nline4");
	});

	it("trims whitespace when normalizing", () => {
		expect(appendObservations("  existing  ", "  incoming  ")).toBe("existing\n\nincoming");
	});
});
