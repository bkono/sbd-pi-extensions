import { describe, expect, it } from "vitest";
import { buildStaleContextRecord } from "../src/context-hygiene.js";

describe("context hygiene stale result contract", () => {
  it("builds an explicit stale invalidation record with original and mutation metadata", () => {
    const rehydrate = {
      tool: "read" as const,
      input: { path: "src/read.ts", offset: 10, limit: 5 },
    };

    const record = buildStaleContextRecord({
      originalTool: "read",
      originalResultId: "read-result-1",
      staleResourceKeys: ["file:src/read.ts", "file:src/read.ts"],
      invalidatingMutationEventId: 42,
      invalidatingMutationResultId: "edit-result-1",
      rehydrate,
    });

    expect(record).toEqual({
      status: "stale",
      originalTool: "read",
      originalResultId: "read-result-1",
      staleResourceKeys: ["file:src/read.ts"],
      invalidatingMutationEventId: 42,
      invalidatingMutationResultId: "edit-result-1",
      reason: "mutation-after-read",
      rehydrate,
    });
    expect((record as any).state).toBeUndefined();
    expect((record as any).retired).toBeUndefined();
  });
});
