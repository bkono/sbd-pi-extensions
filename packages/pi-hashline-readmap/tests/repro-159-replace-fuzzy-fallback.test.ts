import { describe, expect, it } from "vitest";
import { replaceText } from "../src/edit-diff.js";

describe("repro 159: replace fuzzy fallback", () => {
  it("does not silently replace a stale non-all old_text that only matches after fuzzy normalization", () => {
    const current = "alpha   \n beta\n gamma\n";
    const staleOldText = "alpha\n beta\n gamma\n";

    const result = replaceText(current, staleOldText, "alpha\n", { all: false });

    expect(result).toMatchObject({ content: current, count: 0 });
  });

  it("does not silently replace stale all:true old_text that only matches after fuzzy normalization", () => {
    const current = "alpha   \n beta\n gamma\n";
    const staleOldText = "alpha\n beta\n gamma\n";

    const result = replaceText(current, staleOldText, "alpha\n", { all: true });

    expect(result).toMatchObject({ content: current, count: 0 });
  });
});
