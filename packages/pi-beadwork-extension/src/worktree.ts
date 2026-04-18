import { access, copyFile, mkdir, rm } from "node:fs/promises";
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
  cleanedTransientFiles?: string[];
  repoHead?: string;
  workerHead?: string;
  aheadCount?: number;
  behindCount?: number;
  detail: string;
};

export type WorktreeDivergence = {
  repoHead: string;
  workerHead: string;
  aheadCount: number;
  behindCount: number;
};

export type WorktreeRebaseResult = {
  attempted: boolean;
  rebased: boolean;
  checkedAt: string;
  repoHead: string;
  workerHead: string;
  aheadCount: number;
  behindCount: number;
  detail: string;
};

export type WorktreeValidationResult = {
  checkedAt: string;
  passed: boolean;
  commandsRun: string[];
  detail: string;
};

export type WorktreeLandResult = {
  attempted: boolean;
  landed: boolean;
  checkedAt: string;
  repoHead: string;
  workerHead: string;
  detail: string;
};

function humanizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

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

type WorktreeStatusEntry = {
  code: string;
  path: string;
};

const TRANSIENT_WORKTREE_FILENAMES = new Set(["context.md"]);

function parseStatusEntries(raw: string): WorktreeStatusEntry[] {
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 3)
    .map((line) => ({
      code: line.slice(0, 2),
      path: line.slice(3).trim(),
    }))
    .filter((entry) => entry.path.length > 0);
}

function isTransientWorktreeEntry(entry: WorktreeStatusEntry): boolean {
  if (entry.code !== "??") {
    return false;
  }

  return TRANSIENT_WORKTREE_FILENAMES.has(path.basename(entry.path));
}

async function cleanupTransientWorktreeEntries(input: {
  worktreePath: string;
  entries: WorktreeStatusEntry[];
}): Promise<string[]> {
  const removable = input.entries.filter((entry) => isTransientWorktreeEntry(entry));
  const removed: string[] = [];

  for (const entry of removable) {
    await rm(path.resolve(input.worktreePath, entry.path), {
      force: true,
      recursive: true,
    });
    removed.push(entry.path);
  }

  return removed;
}

async function readWorktreeStatus(input: {
  worktreePath: string;
  runner: ProcessRunner;
}): Promise<{ entries: WorktreeStatusEntry[]; cleanedTransientFiles: string[] }> {
  let statusResult = await input.runner("git", ["status", "--porcelain"], {
    cwd: input.worktreePath,
    timeout: 10_000,
  });
  let entries = parseStatusEntries(statusResult.stdout);
  const cleanedTransientFiles = await cleanupTransientWorktreeEntries({
    worktreePath: input.worktreePath,
    entries,
  });

  if (cleanedTransientFiles.length > 0) {
    statusResult = await input.runner("git", ["status", "--porcelain"], {
      cwd: input.worktreePath,
      timeout: 10_000,
    });
    entries = parseStatusEntries(statusResult.stdout);
  }

  return {
    entries,
    cleanedTransientFiles,
  };
}

export async function inspectWorktreeDivergence(input: {
  repoRoot: string;
  worktreePath: string;
  runner?: ProcessRunner;
}): Promise<WorktreeDivergence> {
  const runner = input.runner ?? defaultProcessRunner;
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

  return {
    repoHead,
    workerHead,
    aheadCount,
    behindCount,
  };
}

export async function rebaseWorktreeOntoRepoHead(input: {
  repoRoot: string;
  worktreePath: string;
  runner?: ProcessRunner;
}): Promise<WorktreeRebaseResult> {
  const runner = input.runner ?? defaultProcessRunner;
  const checkedAt = new Date().toISOString();
  const divergence = await inspectWorktreeDivergence(input);

  if (divergence.aheadCount === 0) {
    return {
      attempted: false,
      rebased: false,
      checkedAt,
      ...divergence,
      detail: "Worker HEAD is already fully contained in repo HEAD.",
    };
  }

  if (divergence.behindCount === 0) {
    return {
      attempted: false,
      rebased: false,
      checkedAt,
      ...divergence,
      detail: "Worker branch is already based on the current repo HEAD.",
    };
  }

  try {
    await runner("git", ["rebase", divergence.repoHead], {
      cwd: input.worktreePath,
      timeout: 300_000,
    });
  } catch (error) {
    try {
      await runner("git", ["rebase", "--abort"], {
        cwd: input.worktreePath,
        timeout: 30_000,
      });
    } catch {
      // ignore abort failures; surface the original rebase error below
    }

    return {
      attempted: true,
      rebased: false,
      checkedAt,
      ...divergence,
      detail: `Rebase onto repo HEAD failed: ${humanizeError(error)}`,
    };
  }

  const nextDivergence = await inspectWorktreeDivergence(input);
  return {
    attempted: true,
    rebased: true,
    checkedAt,
    ...nextDivergence,
    detail:
      nextDivergence.behindCount > 0
        ? `Rebased worker branch onto repo HEAD, but repo advanced again during the operation (ahead=${nextDivergence.aheadCount}, behind=${nextDivergence.behindCount}).`
        : `Rebased worker branch onto repo HEAD (ahead=${nextDivergence.aheadCount}, behind=${nextDivergence.behindCount}).`,
  };
}

export async function runWorktreeValidation(input: {
  worktreePath: string;
  commands: string[];
  timeoutMs?: number;
  runner?: ProcessRunner;
}): Promise<WorktreeValidationResult> {
  const runner = input.runner ?? defaultProcessRunner;
  const checkedAt = new Date().toISOString();
  const commandsRun: string[] = [];

  if (input.commands.length === 0) {
    return {
      checkedAt,
      passed: true,
      commandsRun,
      detail: "No validation commands configured.",
    };
  }

  for (const command of input.commands) {
    try {
      await runner("bash", ["-lc", command], {
        cwd: input.worktreePath,
        timeout: input.timeoutMs ?? 600_000,
      });
      commandsRun.push(command);
    } catch (error) {
      return {
        checkedAt,
        passed: false,
        commandsRun,
        detail: `Validation failed on \`${command}\`: ${humanizeError(error)}`,
      };
    }
  }

  return {
    checkedAt,
    passed: true,
    commandsRun,
    detail: `Validation passed: ${input.commands.join(", ")}.`,
  };
}

export async function landWorktreeBranch(input: {
  repoRoot: string;
  worktreePath: string;
  runner?: ProcessRunner;
}): Promise<WorktreeLandResult> {
  const runner = input.runner ?? defaultProcessRunner;
  const checkedAt = new Date().toISOString();
  const divergence = await inspectWorktreeDivergence(input);

  if (divergence.aheadCount === 0) {
    return {
      attempted: false,
      landed: true,
      checkedAt,
      repoHead: divergence.repoHead,
      workerHead: divergence.workerHead,
      detail: "Worker HEAD is already present in repo HEAD.",
    };
  }

  try {
    await runner("git", ["merge", "--ff-only", divergence.workerHead], {
      cwd: input.repoRoot,
      timeout: 300_000,
    });
  } catch (error) {
    return {
      attempted: true,
      landed: false,
      checkedAt,
      repoHead: divergence.repoHead,
      workerHead: divergence.workerHead,
      detail: `Fast-forward landing failed: ${humanizeError(error)}`,
    };
  }

  const nextRepoHead = await readGitRevision(input.repoRoot, "HEAD", runner);
  return {
    attempted: true,
    landed: true,
    checkedAt,
    repoHead: nextRepoHead,
    workerHead: divergence.workerHead,
    detail: `Landed worker HEAD ${divergence.workerHead} into repo HEAD via fast-forward.`,
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

  const { entries: statusEntries, cleanedTransientFiles } = await readWorktreeStatus({
    worktreePath: input.worktreePath,
    runner,
  });
  const worktreeClean = statusEntries.length === 0;

  if (!worktreeClean) {
    return {
      checkedAt,
      verified: false,
      ticketClosed: true,
      worktreeClean,
      cleanedTransientFiles,
      detail:
        cleanedTransientFiles.length > 0
          ? "Ticket is closed, and transient handoff files were cleaned up, but the worktree still has other uncommitted changes."
          : "Ticket is closed, but the worktree still has uncommitted changes.",
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
      cleanedTransientFiles,
      repoHead,
      workerHead,
      aheadCount,
      behindCount,
      detail:
        behindCount > 0
          ? `Ticket is closed and the worktree is clean, but ${aheadCount} worker commit(s) still need to be integrated into repo HEAD (worker branch also trails repo by ${behindCount} commit(s)).`
          : `Ticket is closed and the worktree is clean, but ${aheadCount} worker commit(s) are not in the repo HEAD yet.`,
    };
  }

  return {
    checkedAt,
    verified: true,
    ticketClosed: true,
    worktreeClean,
    cleanedTransientFiles,
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

export async function cleanupWorkerRuntimeDir(input: {
  runtimeDir: string;
  runtimeRoot?: string;
}): Promise<{ removed: boolean }> {
  const runtimeDir = path.resolve(input.runtimeDir);

  if (input.runtimeRoot) {
    const runtimeRoot = path.resolve(input.runtimeRoot);
    const relative = path.relative(runtimeRoot, runtimeDir);
    if (
      relative.length === 0 ||
      relative === "." ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Refusing to remove runtime artifacts outside ${runtimeRoot}: ${runtimeDir}`);
    }
  }

  if (!(await pathExists(runtimeDir))) {
    return { removed: false };
  }

  await rm(runtimeDir, { recursive: true, force: true });
  return { removed: true };
}

export async function cleanupTicketWorktree(input: {
  repoRoot: string;
  worktreePath: string;
  runtimeDir?: string;
  runtimeRoot?: string;
  runner?: ProcessRunner;
}): Promise<{ removed: boolean; runtimeRemoved: boolean }> {
  const runner = input.runner ?? defaultProcessRunner;
  let removed = false;

  if (await pathExists(input.worktreePath)) {
    await runner("git", ["worktree", "remove", "--force", input.worktreePath], {
      cwd: input.repoRoot,
      timeout: 30_000,
    });
    removed = true;
  }

  const runtimeRemoved = input.runtimeDir
    ? (
        await cleanupWorkerRuntimeDir({
          runtimeDir: input.runtimeDir,
          runtimeRoot: input.runtimeRoot,
        })
      ).removed
    : false;

  return { removed, runtimeRemoved };
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
