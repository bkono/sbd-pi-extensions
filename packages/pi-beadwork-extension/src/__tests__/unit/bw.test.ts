import { describe, expect, it, vi } from "vitest";
import { BeadworkCommandError, createBeadworkAdapter } from "../../bw.js";

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

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

  it("serializes concurrent mutations per cwd", async () => {
    let resolveFirst:
      | ((value: { code: number; stdout: string; stderr: string }) => void)
      | undefined;
    const firstCall = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const exec = vi
      .fn()
      .mockImplementationOnce(() => firstCall)
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const adapter = createBeadworkAdapter(exec);
    const first = adapter.addDependency("/repo-serial", "BW-100", "BW-200");
    const second = adapter.addDependency("/repo-serial", "BW-200", "BW-300");

    await flushMicrotasks();
    expect(exec).toHaveBeenCalledTimes(1);
    resolveFirst?.({ code: 0, stdout: "", stderr: "" });
    await first;
    await flushMicrotasks();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(1, "bw", ["dep", "add", "BW-100", "blocks", "BW-200"], {
      cwd: "/repo-serial",
      timeout: 10_000,
    });
    expect(exec).toHaveBeenNthCalledWith(2, "bw", ["dep", "add", "BW-200", "blocks", "BW-300"], {
      cwd: "/repo-serial",
      timeout: 10_000,
    });
    await second;
  });

  it("retries moved-ref conflicts once before syncing", async () => {
    const movedRef = new BeadworkCommandError({
      command: "bw",
      args: ["dep", "add", "BW-100", "blocks", "BW-200"],
      cwd: "/repo",
      code: 1,
      stderr:
        "commit failed: conflict: ref refs/heads/beadwork has moved (expected abc12345, got def67890)",
    });
    const exec = vi
      .fn()
      .mockRejectedValueOnce(movedRef)
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const adapter = createBeadworkAdapter(exec);
    await adapter.addDependency("/repo-retry-once", "BW-100", "BW-200");
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(1, "bw", ["dep", "add", "BW-100", "blocks", "BW-200"], {
      cwd: "/repo-retry-once",
      timeout: 10_000,
    });
    expect(exec).toHaveBeenNthCalledWith(2, "bw", ["dep", "add", "BW-100", "blocks", "BW-200"], {
      cwd: "/repo-retry-once",
      timeout: 10_000,
    });
  });

  it("runs bw sync before a final retry after repeated moved-ref conflicts", async () => {
    const movedRef = new BeadworkCommandError({
      command: "bw",
      args: ["dep", "add", "BW-100", "blocks", "BW-200"],
      cwd: "/repo",
      code: 1,
      stderr:
        "commit failed: conflict: ref refs/heads/beadwork has moved (expected abc12345, got def67890)",
    });
    const exec = vi
      .fn()
      .mockRejectedValueOnce(movedRef)
      .mockRejectedValueOnce(movedRef)
      .mockResolvedValueOnce({ code: 0, stdout: "up to date", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const adapter = createBeadworkAdapter(exec);
    await adapter.addDependency("/repo-retry-sync", "BW-100", "BW-200");
    expect(exec).toHaveBeenCalledTimes(4);
    expect(exec).toHaveBeenNthCalledWith(1, "bw", ["dep", "add", "BW-100", "blocks", "BW-200"], {
      cwd: "/repo-retry-sync",
      timeout: 10_000,
    });
    expect(exec).toHaveBeenNthCalledWith(2, "bw", ["dep", "add", "BW-100", "blocks", "BW-200"], {
      cwd: "/repo-retry-sync",
      timeout: 10_000,
    });
    expect(exec).toHaveBeenNthCalledWith(3, "bw", ["sync"], {
      cwd: "/repo-retry-sync",
      timeout: 10_000,
    });
    expect(exec).toHaveBeenNthCalledWith(4, "bw", ["dep", "add", "BW-100", "blocks", "BW-200"], {
      cwd: "/repo-retry-sync",
      timeout: 10_000,
    });
  });
});
