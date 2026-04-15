import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildTicketBranchName,
  cleanupTicketWorktree,
  landWorktreeBranch,
  prepareTicketWorktree,
  rebaseWorktreeOntoRepoHead,
  runWorktreeValidation,
  verifyWorktreeLanding,
} from "../../worktree.js";

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

  it("verifies landing when the ticket is closed, the worktree is clean, and repo HEAD contains the worker HEAD", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-landing-"));
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const runner = vi.fn(async (_command: string, args: string[], options?: { cwd?: string }) => {
      if (args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: "repo-head\n", stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (args[0] === "rev-list") {
        return { stdout: "2 0\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await verifyWorktreeLanding({
      repoRoot,
      worktreePath,
      ticketClosed: true,
      runner,
    });

    expect(result.verified).toBe(true);
    expect(result.aheadCount).toBe(0);
    expect(result.behindCount).toBe(2);
    expect(result.detail).toContain("Landing verified");
  });

  it("does not verify landing while worker commits are still ahead of repo HEAD", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-landing-"));
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: "repo-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { stdout: "1 3\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await verifyWorktreeLanding({
      repoRoot,
      worktreePath,
      ticketClosed: true,
      runner,
    });

    expect(result.verified).toBe(false);
    expect(result.aheadCount).toBe(3);
    expect(result.behindCount).toBe(1);
    expect(result.detail).toContain("still need to be integrated into repo HEAD");
  });

  it("returns a pending-review result when worker commits are still ahead of repo HEAD and not diverged", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-landing-"));
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: "repo-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { stdout: "0 3\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await verifyWorktreeLanding({
      repoRoot,
      worktreePath,
      ticketClosed: true,
      runner,
    });

    expect(result.verified).toBe(false);
    expect(result.aheadCount).toBe(3);
    expect(result.detail).toContain("not in the repo HEAD yet");
  });

  it("rebases a diverged worker branch onto repo HEAD", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-rebase-"));
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    let rebased = false;
    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return { stdout: "repo-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return {
          stdout: rebased ? "worker-rebased\n" : "worker-head\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "rev-list") {
        return {
          stdout: rebased ? "0 2\n" : "3 2\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "rebase") {
        rebased = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await rebaseWorktreeOntoRepoHead({
      repoRoot,
      worktreePath,
      runner,
    });

    expect(result.attempted).toBe(true);
    expect(result.rebased).toBe(true);
    expect(result.behindCount).toBe(0);
    expect(result.aheadCount).toBe(2);
  });

  it("runs validation commands in order and stops on failure", async () => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), "pi-bw-validate-"));
    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[1] === "npm run test") {
        throw new Error("tests failed");
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await runWorktreeValidation({
      worktreePath,
      commands: ["npm run lint", "npm run test", "npm run typecheck"],
      runner,
    });

    expect(result.passed).toBe(false);
    expect(result.commandsRun).toEqual(["npm run lint"]);
    expect(result.detail).toContain("npm run test");
  });

  it("fast-forwards repo HEAD to the worker HEAD when landing", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-land-"));
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    let merged = false;
    const runner = vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === repoRoot) {
        return {
          stdout: merged ? "worker-head\n" : "repo-head\n",
          stderr: "",
          code: 0,
        };
      }
      if (command === "git" && args[0] === "rev-parse" && options?.cwd === worktreePath) {
        return { stdout: "worker-head\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { stdout: "0 2\n", stderr: "", code: 0 };
      }
      if (command === "git" && args[0] === "merge") {
        merged = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await landWorktreeBranch({
      repoRoot,
      worktreePath,
      runner,
    });

    expect(result.attempted).toBe(true);
    expect(result.landed).toBe(true);
    expect(result.repoHead).toBe("worker-head");
  });

  it("removes a landed worktree when cleanup is requested", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-cleanup-"));
    const worktreePath = path.join(repoRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const runner = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));

    const result = await cleanupTicketWorktree({
      repoRoot,
      worktreePath,
      runner,
    });

    expect(result).toEqual({ removed: true });
    expect(runner).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", worktreePath],
      expect.objectContaining({ cwd: repoRoot }),
    );
  });
});
