import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { defaultProcessRunner, type ProcessRunner, slugify } from "./process.js";

export type PreparedWorktree = {
  branchName: string;
  worktreePath: string;
  reused: boolean;
};

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function gitBranchExists(
  repoRoot: string,
  branchName: string,
  runner: ProcessRunner,
): Promise<boolean> {
  const result = await runner("git", ["branch", "--list", branchName], {
    cwd: repoRoot,
  });
  return result.stdout.trim().length > 0;
}

export function buildTicketBranchName(ticketId: string, title: string): string {
  return `${ticketId}/${slugify(title)}`;
}

export function resolveWorktreeBaseDir(repoRoot: string, configuredBaseDir?: string): string {
  if (configuredBaseDir) {
    return path.isAbsolute(configuredBaseDir)
      ? configuredBaseDir
      : path.resolve(repoRoot, configuredBaseDir);
  }

  const repoParent = path.dirname(repoRoot);
  const repoName = path.basename(repoRoot);
  return path.join(repoParent, `${repoName}-worktrees`);
}

export async function prepareTicketWorktree(input: {
  repoRoot: string;
  ticketId: string;
  title: string;
  baseDir?: string;
  runner?: ProcessRunner;
}): Promise<PreparedWorktree> {
  const runner = input.runner ?? defaultProcessRunner;
  const branchName = buildTicketBranchName(input.ticketId, input.title);
  const slug = slugify(input.title);
  const baseDir = resolveWorktreeBaseDir(input.repoRoot, input.baseDir);
  const worktreePath = path.join(baseDir, `${input.ticketId}-${slug}`);

  await mkdir(baseDir, { recursive: true });

  if (await pathExists(worktreePath)) {
    return {
      branchName,
      worktreePath,
      reused: true,
    };
  }

  const branchExists = await gitBranchExists(input.repoRoot, branchName, runner);
  const args = branchExists
    ? ["worktree", "add", worktreePath, branchName]
    : ["worktree", "add", "-b", branchName, worktreePath, "HEAD"];

  await runner("git", args, { cwd: input.repoRoot, timeout: 30_000 });

  return {
    branchName,
    worktreePath,
    reused: false,
  };
}
