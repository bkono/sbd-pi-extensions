import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { defaultProcessRunner, type ProcessRunner, slugify } from "./process.js";
import type { WorktreeCopyRule } from "./types.js";

export type PreparedWorktree = {
  branchName: string;
  worktreePath: string;
  reused: boolean;
  copiedFiles: string[];
  setupCommandsRun: string[];
};

export type LandingVerificationResult = {
  checkedAt: string;
  verified: boolean;
  ticketClosed: boolean;
  worktreeClean?: boolean;
  repoHead?: string;
  workerHead?: string;
  aheadCount?: number;
  behindCount?: number;
  detail: string;
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

async function readGitRevision(
  cwd: string,
  revision: string,
  runner: ProcessRunner,
): Promise<string> {
  const result = await runner("git", ["rev-parse", revision], {
    cwd,
    timeout: 10_000,
  });
  return result.stdout.trim();
}

async function readAheadBehindCounts(
  repoRoot: string,
  repoHead: string,
  workerHead: string,
  runner: ProcessRunner,
): Promise<{ behindCount: number; aheadCount: number }> {
  const result = await runner(
    "git",
    ["rev-list", "--left-right", "--count", `${repoHead}...${workerHead}`],
    {
      cwd: repoRoot,
      timeout: 10_000,
    },
  );
  const [behindRaw = "0", aheadRaw = "0"] = result.stdout.trim().split(/\s+/, 2);
  const behindCount = Number.parseInt(behindRaw, 10);
  const aheadCount = Number.parseInt(aheadRaw, 10);
  return {
    behindCount: Number.isFinite(behindCount) ? behindCount : 0,
    aheadCount: Number.isFinite(aheadCount) ? aheadCount : 0,
  };
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

function normalizeCopyRule(rule: WorktreeCopyRule): {
  from: string;
  to?: string;
  required: boolean;
} {
  if (typeof rule === "string") {
    return {
      from: rule,
      to: rule,
      required: false,
    };
  }

  return {
    from: rule.from,
    to: rule.to ?? rule.from,
    required: rule.required ?? false,
  };
}

async function copyConfiguredFiles(input: {
  repoRoot: string;
  worktreePath: string;
  copyFiles: WorktreeCopyRule[];
}): Promise<string[]> {
  const copiedFiles: string[] = [];

  for (const rule of input.copyFiles) {
    const normalized = normalizeCopyRule(rule);
    const sourcePath = path.isAbsolute(normalized.from)
      ? normalized.from
      : path.resolve(input.repoRoot, normalized.from);
    const targetPath = path.isAbsolute(normalized.to ?? "")
      ? (normalized.to as string)
      : path.resolve(input.worktreePath, normalized.to ?? normalized.from);

    if (!(await pathExists(sourcePath))) {
      if (normalized.required) {
        throw new Error(`Configured worktree copy source is missing: ${sourcePath}`);
      }
      continue;
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    copiedFiles.push(path.relative(input.worktreePath, targetPath));
  }

  return copiedFiles;
}

async function runSetupCommands(input: {
  worktreePath: string;
  setupCommands: string[];
  runner: ProcessRunner;
}): Promise<string[]> {
  const commandsRun: string[] = [];

  for (const command of input.setupCommands) {
    await input.runner("bash", ["-lc", command], {
      cwd: input.worktreePath,
      timeout: 300_000,
    });
    commandsRun.push(command);
  }

  return commandsRun;
}

export async function verifyWorktreeLanding(input: {
  repoRoot: string;
  worktreePath: string;
  ticketClosed: boolean;
  runner?: ProcessRunner;
}): Promise<LandingVerificationResult> {
  const runner = input.runner ?? defaultProcessRunner;
  const checkedAt = new Date().toISOString();

  if (!input.ticketClosed) {
    return {
      checkedAt,
      verified: false,
      ticketClosed: false,
      detail: "Ticket is not closed yet.",
    };
  }

  if (!(await pathExists(input.worktreePath))) {
    return {
      checkedAt,
      verified: false,
      ticketClosed: true,
      detail: `Worktree path is missing: ${input.worktreePath}`,
    };
  }

  const statusResult = await runner("git", ["status", "--porcelain"], {
    cwd: input.worktreePath,
    timeout: 10_000,
  });
  const worktreeClean = statusResult.stdout.trim().length === 0;

  if (!worktreeClean) {
    return {
      checkedAt,
      verified: false,
      ticketClosed: true,
      worktreeClean,
      detail: "Ticket is closed, but the worktree still has uncommitted changes.",
    };
  }

  const [repoHead, workerHead] = await Promise.all([
    readGitRevision(input.repoRoot, "HEAD", runner),
    readGitRevision(input.worktreePath, "HEAD", runner),
  ]);
  const { behindCount, aheadCount } = await readAheadBehindCounts(
    input.repoRoot,
    repoHead,
    workerHead,
    runner,
  );

  if (aheadCount > 0) {
    return {
      checkedAt,
      verified: false,
      ticketClosed: true,
      worktreeClean,
      repoHead,
      workerHead,
      aheadCount,
      behindCount,
      detail: `Ticket is closed and the worktree is clean, but ${aheadCount} worker commit(s) are not in the repo HEAD yet.`,
    };
  }

  return {
    checkedAt,
    verified: true,
    ticketClosed: true,
    worktreeClean,
    repoHead,
    workerHead,
    aheadCount,
    behindCount,
    detail:
      behindCount > 0
        ? `Landing verified: worktree is clean and worker HEAD is fully contained in repo HEAD (${behindCount} repo commit(s) ahead).`
        : "Landing verified: worktree is clean and worker HEAD matches repo HEAD.",
  };
}

export async function cleanupTicketWorktree(input: {
  repoRoot: string;
  worktreePath: string;
  runner?: ProcessRunner;
}): Promise<{ removed: boolean }> {
  const runner = input.runner ?? defaultProcessRunner;

  if (!(await pathExists(input.worktreePath))) {
    return { removed: false };
  }

  await runner("git", ["worktree", "remove", "--force", input.worktreePath], {
    cwd: input.repoRoot,
    timeout: 30_000,
  });

  return { removed: true };
}

export async function prepareTicketWorktree(input: {
  repoRoot: string;
  ticketId: string;
  title: string;
  baseDir?: string;
  copyFiles?: WorktreeCopyRule[];
  setupCommands?: string[];
  rerunSetupOnReuse?: boolean;
  runner?: ProcessRunner;
}): Promise<PreparedWorktree> {
  const runner = input.runner ?? defaultProcessRunner;
  const branchName = buildTicketBranchName(input.ticketId, input.title);
  const slug = slugify(input.title);
  const baseDir = resolveWorktreeBaseDir(input.repoRoot, input.baseDir);
  const worktreePath = path.join(baseDir, `${input.ticketId}-${slug}`);
  const copyFiles = input.copyFiles ?? [];
  const setupCommands = input.setupCommands ?? [];

  await mkdir(baseDir, { recursive: true });

  if (await pathExists(worktreePath)) {
    const copiedFiles = input.rerunSetupOnReuse
      ? await copyConfiguredFiles({ repoRoot: input.repoRoot, worktreePath, copyFiles })
      : [];
    const setupCommandsRun = input.rerunSetupOnReuse
      ? await runSetupCommands({ worktreePath, setupCommands, runner })
      : [];

    return {
      branchName,
      worktreePath,
      reused: true,
      copiedFiles,
      setupCommandsRun,
    };
  }

  const branchExists = await gitBranchExists(input.repoRoot, branchName, runner);
  const args = branchExists
    ? ["worktree", "add", worktreePath, branchName]
    : ["worktree", "add", "-b", branchName, worktreePath, "HEAD"];

  await runner("git", args, { cwd: input.repoRoot, timeout: 30_000 });

  const copiedFiles = await copyConfiguredFiles({
    repoRoot: input.repoRoot,
    worktreePath,
    copyFiles,
  });
  const setupCommandsRun = await runSetupCommands({ worktreePath, setupCommands, runner });

  return {
    branchName,
    worktreePath,
    reused: false,
    copiedFiles,
    setupCommandsRun,
  };
}
