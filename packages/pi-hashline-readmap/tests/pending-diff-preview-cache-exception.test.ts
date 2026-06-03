import { describe, expect, it, vi } from "vitest";
import { resolvePendingDiffPreview } from "../src/pending-diff-preview.js";

describe("pending diff preview cache exceptions", () => {
  it("turns synchronous projection exceptions into cached skips", () => {
    const context: any = { state: {}, invalidate: vi.fn() };

    const thrown = resolvePendingDiffPreview(context, "throwing-preview", "throw-key", () => {
      throw new Error("projection exploded");
    });
    const cached = resolvePendingDiffPreview(context, "throwing-preview", "throw-key", () => {
      throw new Error("projection exploded again");
    });

    expect(thrown).toEqual({ type: "skip", reason: expect.stringContaining("projection") });
    expect(cached).toEqual(thrown);
  });
});
