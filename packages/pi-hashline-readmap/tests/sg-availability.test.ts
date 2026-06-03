import { describe, expect, it } from "vitest";
import { isSgAvailable } from "../src/sg.js";

describe("isSgAvailable", () => {
  it("returns a boolean", () => {
    const result = isSgAvailable();
    expect(typeof result).toBe("boolean");
  });
});
