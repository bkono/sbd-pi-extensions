import { describe, expect, it } from "vitest";
import { computeKey } from "../src/persistent-map-cache.js";

describe("persistent-map-cache key (AC 27)", () => {
  it("same path + same mtime + different contentHash → different keys", () => {
    const a = computeKey("/abs/x.ts", 1000, "deadbeef", "typescript", 1);
    const b = computeKey("/abs/x.ts", 1000, "cafef00d", "typescript", 1);
    expect(a).not.toBe(b);
  });

  it("identical inputs → identical keys (deterministic)", () => {
    const a = computeKey("/abs/x.ts", 1000, "deadbeef", "typescript", 1);
    const b = computeKey("/abs/x.ts", 1000, "deadbeef", "typescript", 1);
    expect(a).toBe(b);
  });

  it("different mapperVersion → different keys (per AGENTS.md MAPPER_VERSION rule)", () => {
    const a = computeKey("/abs/x.ts", 1000, "deadbeef", "typescript", 1);
    const b = computeKey("/abs/x.ts", 1000, "deadbeef", "typescript", 2);
    expect(a).not.toBe(b);
  });
});
