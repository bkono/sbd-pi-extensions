import { describe, expect, it, vi } from "vitest";
import { createBeadworkAdapter } from "../../bw.js";

describe("beadwork adapter", () => {
  it("loads ready issues and normalizes fields", async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        {
          id: "BW-100",
          title: "Ready task",
          status: "open",
          type: "task",
          priority: 1,
          labels: ["backend"],
          blocked_by: ["BW-050"],
          blocks: ["BW-200"],
          created: "2026-04-13T00:00:00Z",
          updated_at: "2026-04-13T00:01:00Z",
        },
      ]),
      stderr: "",
    });

    const adapter = createBeadworkAdapter(exec);
    const ready = await adapter.ready("/repo", "BW-999");

    expect(exec).toHaveBeenCalledWith("bw", ["ready", "BW-999", "--json"], {
      cwd: "/repo",
      timeout: 10_000,
    });
    expect(ready).toEqual([
      {
        id: "BW-100",
        title: "Ready task",
        description: "",
        status: "open",
        type: "task",
        priority: 1,
        labels: ["backend"],
        blockedBy: ["BW-050"],
        blocks: ["BW-200"],
        assignee: "",
        createdAt: "2026-04-13T00:00:00Z",
        updatedAt: "2026-04-13T00:01:00Z",
      },
    ]);
  });

  it("combines show details with children listing", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          id: "BW-100",
          title: "Epic",
          status: "open",
          type: "epic",
          priority: 2,
          blocked_by: [],
          blocks: [],
          created: "",
          updated_at: "",
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify([
          {
            id: "BW-100.1",
            title: "Child",
            status: "open",
            type: "task",
            priority: 2,
            blocked_by: [],
            blocks: [],
            created: "",
            updated_at: "",
            parent: "BW-100",
          },
        ]),
        stderr: "",
      });

    const adapter = createBeadworkAdapter(exec);
    const detail = await adapter.show("/repo", "BW-100");

    expect(detail.id).toBe("BW-100");
    expect(detail.children).toHaveLength(1);
    expect(detail.children[0].parentId).toBe("BW-100");
  });
});
