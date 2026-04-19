import { describe, expect, it, vi } from "vitest";
import { createBeadworkCommandCompletionFactory } from "../../command-completions.js";

describe("beadwork command completions", () => {
  it("suggests subcommands for the main /bw command", async () => {
    const completions = createBeadworkCommandCompletionFactory({
      adapter: {
        ready: vi.fn(),
        list: vi.fn(),
      },
      detectActivation: vi.fn(),
      getCwd: () => "/repo",
    });

    const items = await completions.getMainCommandCompletions("de");
    expect(items?.map((item) => item.value)).toContain("delegate");
    expect(items?.map((item) => item.value)).not.toContain("run");
  });

  it("offers ready non-epic tickets for /bw:delegate completions", async () => {
    const adapter = {
      ready: vi.fn().mockResolvedValue([
        {
          id: "BW-100",
          title: "Epic",
          description: "",
          status: "open",
          type: "epic",
          priority: 1,
          labels: [],
          blockedBy: [],
          blocks: [],
          assignee: "",
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "BW-101",
          title: "Task",
          description: "",
          status: "open",
          type: "task",
          priority: 2,
          labels: [],
          blockedBy: [],
          blocks: [],
          assignee: "",
          createdAt: "",
          updatedAt: "",
        },
      ]),
      list: vi.fn(),
    };
    const completions = createBeadworkCommandCompletionFactory({
      adapter,
      detectActivation: vi.fn().mockResolvedValue({ kind: "active", repoRoot: "/repo" }),
      getCwd: () => "/repo",
    });

    const items = await completions.getAliasCommandCompletions("delegate", "BW-");
    expect(items).toEqual([
      {
        value: "BW-101",
        label: "BW-101 · open",
        description: "Task",
      },
    ]);
  });
});
