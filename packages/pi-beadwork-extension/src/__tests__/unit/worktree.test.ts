import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[4], { recursive: true });
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await prepareTicketWorktree({
      repoRoot,
      ticketId: "BW-123",
      title: "Fix auth token refresh",
      runner,
    });

    expect(result.branchName).toBe("BW-123/fix-auth-token-refresh");
    expect(result.worktreePath).toContain("BW-123-fix-auth-token-refresh");
    expect(result.copiedFiles).toEqual([]);
    expect(result.setupCommandsRun).toEqual([]);
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "git",
      ["worktree", "add", "-b", "BW-123/fix-auth-token-refresh", result.worktreePath, "HEAD"],
      expect.objectContaining({ cwd: repoRoot }),
    );
  });

  it("copies configured files and runs setup commands for a new worktree", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-worktree-"));
    await writeFile(path.join(repoRoot, ".env"), "TOKEN=abc\n", "utf8");
    await writeFile(path.join(repoRoot, ".mise.local.toml"), "[tools]\n", "utf8");

    const runner = vi.fn(async (command: string, args: string[], _options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[4], { recursive: true });
      }
      return {
        stdout: "",
        stderr: "",
        code: 0,
      };
    });

    const result = await prepareTicketWorktree({
      repoRoot,
      ticketId: "BW-123",
      title: "Fix auth token refresh",
      copyFiles: [".env", ".mise.local.toml"],
      setupCommands: ["mise trust", "npm install"],
      runner,
    });

    expect(result.copiedFiles).toEqual([".env", ".mise.local.toml"]);
    expect(result.setupCommandsRun).toEqual(["mise trust", "npm install"]);
    await expect(readFile(path.join(result.worktreePath, ".env"), "utf8")).resolves.toBe(
      "TOKEN=abc\n",
    );
    await expect(
      readFile(path.join(result.worktreePath, ".mise.local.toml"), "utf8"),
    ).resolves.toBe("[tools]\n");
    expect(runner).toHaveBeenCalledWith(
      "bash",
      ["-lc", "mise trust"],
      expect.objectContaining({ cwd: result.worktreePath }),
    );
    expect(runner).toHaveBeenCalledWith(
      "bash",
      ["-lc", "npm install"],
      expect.objectContaining({ cwd: result.worktreePath }),
    );
  });

  it("can rerun copy/setup when reusing an existing worktree", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-worktree-"));
    const baseDir = path.join(repoRoot, "../worktrees");
    const worktreePath = path.join(baseDir, "BW-123-fix-auth-token-refresh");
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(repoRoot, ".env"), "TOKEN=abc\n", "utf8");

    const runner = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));

    const result = await prepareTicketWorktree({
      repoRoot,
      ticketId: "BW-123",
      title: "Fix auth token refresh",
      baseDir,
      copyFiles: [".env"],
      setupCommands: ["npm install"],
      rerunSetupOnReuse: true,
      runner,
    });

    expect(result.reused).toBe(true);
    expect(result.copiedFiles).toEqual([".env"]);
    expect(result.setupCommandsRun).toEqual(["npm install"]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(
      "bash",
      ["-lc", "npm install"],
      expect.objectContaining({ cwd: worktreePath }),
    );
  });
});
