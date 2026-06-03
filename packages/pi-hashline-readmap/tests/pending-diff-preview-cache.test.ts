import { describe, expect, it, vi } from "vitest";
import { resolvePendingDiffPreview } from "../src/pending-diff-preview.js";

describe("pending diff preview cache", () => {
  it("reuses cached data for identical keys", async () => {
    const context: any = { state: {}, invalidate: vi.fn() };
    let calls = 0;

    const first = resolvePendingDiffPreview(context, "preview", "key-1", () => {
      calls++;
      return { type: "skip" as const, reason: "first" };
    });
    const second = resolvePendingDiffPreview(context, "preview", "key-1", () => {
      calls++;
      return { type: "skip" as const, reason: "second" };
    });

    expect(first).toEqual({ type: "skip", reason: "first" });
    expect(second).toEqual({ type: "skip", reason: "first" });
    expect(calls).toBe(1);

    const third = resolvePendingDiffPreview(context, "preview", "key-2", () => {
      calls++;
      return Promise.resolve({ type: "skip" as const, reason: "third" });
    });
    expect(third).toBeUndefined();
    expect(calls).toBe(2);

    await Promise.resolve();
    const fourth = resolvePendingDiffPreview(context, "preview", "key-2", () => {
      calls++;
      return { type: "skip" as const, reason: "fourth" };
    });

    expect(fourth).toEqual({ type: "skip", reason: "third" });
    expect(calls).toBe(2);
    expect(context.invalidate).toHaveBeenCalledTimes(1);
  });
});
