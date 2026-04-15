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

  it("treats null child lists as empty when showing a task", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          id: "BW-100.1",
          title: "Task",
          status: "open",
          type: "task",
          priority: 2,
          blocked_by: [],
          blocks: [],
          created: "",
          updated_at: "",
          parent: "BW-100",
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "null",
        stderr: "",
      });

    const adapter = createBeadworkAdapter(exec);
    const detail = await adapter.show("/repo", "BW-100.1");

    expect(detail.id).toBe("BW-100.1");
    expect(detail.parentId).toBe("BW-100");
    expect(detail.children).toEqual([]);
  });

  it("treats null list results as empty arrays", async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "null",
      stderr: "",
    });

    const adapter = createBeadworkAdapter(exec);
    const issues = await adapter.list("/repo", { all: true, parent: "BW-100.1" });

    expect(issues).toEqual([]);
  });

  it("updates issue fields including parent/due clearing", async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        id: "BW-100.1",
        title: "Retitled",
        status: "open",
        type: "task",
        priority: 2,
        blocked_by: [],
        blocks: [],
        created: "",
        updated_at: "",
      }),
      stderr: "",
    });

    const adapter = createBeadworkAdapter(exec);
    await adapter.updateIssue("/repo", "BW-100.1", {
      title: "Retitled",
      parentId: null,
      dueAt: null,
      deferUntil: "tomorrow",
    });

    expect(exec).toHaveBeenCalledWith(
      "bw",
      [
        "update",
        "BW-100.1",
        "--json",
        "--title",
        "Retitled",
        "--defer",
        "tomorrow",
        "--parent",
        "",
        "--due",
        "",
      ],
      {
        cwd: "/repo",
        timeout: 10_000,
      },
    );
  });

  it("loads issue history entries as structured data", async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        {
          hash: "abc123",
          timestamp: "2026-04-15 12:00",
          author: "beadwork",
          intent: "update BW-100 --parent BW-1",
        },
      ]),
      stderr: "",
    });

    const adapter = createBeadworkAdapter(exec);
    const entries = await adapter.history("/repo", "BW-100", 5);

    expect(exec).toHaveBeenCalledWith("bw", ["history", "BW-100", "--limit", "5", "--json"], {
      cwd: "/repo",
      timeout: 10_000,
    });
    expect(entries[0]).toMatchObject({
      hash: "abc123",
      intent: "update BW-100 --parent BW-1",
    });
  });

  it("runs label mutations and validates operation input", async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        id: "BW-100",
        title: "Task",
        status: "open",
        type: "task",
        priority: 2,
        labels: ["bug"],
      }),
      stderr: "",
    });

    const adapter = createBeadworkAdapter(exec);
    await adapter.label("/repo", "BW-100", ["+bug"]);

    expect(exec).toHaveBeenCalledWith("bw", ["label", "BW-100", "+bug", "--json"], {
      cwd: "/repo",
      timeout: 10_000,
    });
    await expect(adapter.label("/repo", "BW-100", [])).rejects.toThrow(
      "At least one label operation is required.",
    );
  });
});
