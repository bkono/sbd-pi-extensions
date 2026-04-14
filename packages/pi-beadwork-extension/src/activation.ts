import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { DEFAULT_BEADWORK_BRANCH } from "./constants.js";
import type { ActivationState } from "./types.js";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function exec(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], cwd);
    const repoRoot = stdout.trim();
    return repoRoot.length > 0 ? repoRoot : null;
  } catch {
    return null;
  }
}

async function hasBwBinary(): Promise<boolean> {
  try {
    await exec("bw", ["--help"]);
    return true;
  } catch {
    return false;
  }
}

async function hasBeadworkBranch(repoRoot: string): Promise<boolean> {
  try {
    await exec(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${DEFAULT_BEADWORK_BRANCH}`],
      repoRoot,
    );
    return true;
  } catch {
    return false;
  }
}

export async function detectActivation(cwd: string): Promise<ActivationState> {
  if (!(await pathExists(cwd))) {
    return {
      kind: "inactive",
      reason: "cwd-unavailable",
      detail: `Working directory is not accessible: ${cwd}`,
    };
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    return {
      kind: "inactive",
      reason: "no-git",
      detail: "Current working directory is not inside a git repository.",
    };
  }

  const bwAvailable = await hasBwBinary();
  if (!bwAvailable) {
    return {
      kind: "inactive",
      reason: "no-bw",
      repoRoot,
      detail: "The `bw` CLI is not available on PATH.",
    };
  }

  const initialized = await hasBeadworkBranch(repoRoot);
  if (!initialized) {
    return {
      kind: "available",
      reason: "repo-not-initialized",
      repoRoot,
      detail: "Local `beadwork` branch was not found in this repository.",
    };
  }

  return {
    kind: "active",
    repoRoot,
  };
}
