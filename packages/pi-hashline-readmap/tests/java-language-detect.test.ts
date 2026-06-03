import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  getSupportedExtensions,
  isSupported,
} from "../src/readmap/language-detect.js";

describe("Java language detection", () => {
  it("detects .java files as Java", () => {
    expect(detectLanguage("Example.java")).toEqual({ id: "java", name: "Java" });
    expect(detectLanguage("src/main/java/com/example/App.JAVA")).toEqual({
      id: "java",
      name: "Java",
    });
    expect(isSupported("module-info.java")).toBe(true);
    expect(getSupportedExtensions()).toContain(".java");
  });
});
