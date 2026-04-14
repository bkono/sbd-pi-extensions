import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildTicketBranchName, prepareTicketWorktree } from "../../worktree.js";

describe("worktree helpers", () => {
  it("builds a beadwork-style branch name", () => {
    expect(buildTicketBranchName("BW-123", "Fix auth token refresh")).toBe(
      "BW-123/fix-auth-token-refresh",
    );
  });

  it("creates a new worktree on a fresh branch when needed", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-worktree-"));
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0 });

    const result = await prepareTicketWorktree({
      repoRoot,
      ticketId: "BW-123",
      title: "Fix auth token refresh",
      runner,
    });

    expect(result.branchName).toBe("BW-123/fix-auth-token-refresh");
    expect(result.worktreePath).toContain("BW-123-fix-auth-token-refresh");
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "git",
      ["worktree", "add", "-b", "BW-123/fix-auth-token-refresh", result.worktreePath, "HEAD"],
      expect.objectContaining({ cwd: repoRoot }),
    );
  });
});
