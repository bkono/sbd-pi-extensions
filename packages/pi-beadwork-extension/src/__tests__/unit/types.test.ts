import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type Goal, isV1Goal } from "../../types.js";

describe("goal record", () => {
  it("accepts V1 goals with exactly one epic id", () => {
    const goal: Goal = {
      goalId: "goal-1",
      scopeIds: ["BW-100"],
      reviewPolicy: "ticket",
      startedAt: "2026-08-28T00:00:00.000Z",
    };

    expect(isV1Goal(goal)).toBe(true);
    expect(isV1Goal({ ...goal, scopeIds: [] })).toBe(false);
    expect(isV1Goal({ ...goal, scopeIds: ["BW-100", "BW-200"] })).toBe(false);
  });

  it("does not keep WorkerRuntime tmux types after runtime deletion", async () => {
    const source = await readFile(new URL("../../types.ts", import.meta.url), "utf8");
    expect(source).not.toContain("export type WorkerRuntime");
    expect(source).not.toContain('backend: "tmux"');
    expect(source).not.toContain("tmuxSession");
  });
});
