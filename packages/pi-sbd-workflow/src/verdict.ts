import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Independent verdicts per commit. The store and record shape match sbd-mastra-factory's
 * `bin/sbd-verdict`, so a verdict recorded on one host reads on the others.
 */
export const VERDICTS = ["PASS", "PASS+NOTES", "FAIL"] as const;
export type Verdict = (typeof VERDICTS)[number];
const PASSING: ReadonlySet<string> = new Set(["PASS", "PASS+NOTES"]);

export interface VerdictRecord {
  sha: string;
  verdict: Verdict;
  patchId?: string;
  summary: string;
  verifier: { host: string; agent: string; model?: string };
  at: string;
}

export interface CheckResult {
  pass: boolean;
  sha?: string;
  line: string;
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 1 << 28,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

/** The repository's top level, or undefined outside a git work tree. */
export function repoRoot(cwd: string): string | undefined {
  return tryGit(cwd, ["rev-parse", "--show-toplevel"]);
}

export function resolveSha(cwd: string, ref: string): string | undefined {
  return tryGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

/** Tracked files with uncommitted changes. Untracked files do not count. */
export function hasTrackedEdits(cwd: string): boolean {
  return Boolean(tryGit(cwd, ["status", "--porcelain", "--untracked-files=no"]));
}

export function verdictHome(): string {
  return process.env.SBD_VERDICT_HOME ?? join(homedir(), ".local/state/sbd-workflow/verdicts");
}

/** One directory per repository, keyed by its git common dir, so linked worktrees share it. */
export function storeDir(cwd: string, home = verdictHome()): string {
  const common = realpathSync(
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  return join(home, common.replace(/[/\\:]+/g, "-").replace(/^-+/, ""));
}

export function patchId(cwd: string, sha: string): string | undefined {
  try {
    const diff = git(cwd, ["show", "--format=", sha]);
    if (!diff) return undefined;
    return git(cwd, ["patch-id", "--stable"], `${diff}\n`).split(/\s+/)[0] || undefined;
  } catch {
    return undefined;
  }
}

function readRecord(file: string): VerdictRecord | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as VerdictRecord;
  } catch {
    return undefined;
  }
}

/**
 * Exit-0 semantics of `sbd-verdict check`: a passing verdict for the commit, or for an older
 * commit with the same `git patch-id` (Shipping step 3: a verdict covers a patch).
 */
export function checkVerdict(cwd: string, ref: string, home = verdictHome()): CheckResult {
  const sha = resolveSha(cwd, ref);
  if (!sha) return { pass: false, line: `not a commit in this repository: ${ref}` };
  const dir = storeDir(cwd, home);
  const direct = readRecord(join(dir, `${sha}.json`));
  if (direct) {
    return PASSING.has(direct.verdict)
      ? { pass: true, sha, line: `${direct.verdict} ${sha}` }
      : { pass: false, sha, line: `${direct.verdict} ${sha}` };
  }
  const pid = patchId(cwd, sha);
  if (pid && existsSync(dir)) {
    const carried = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readRecord(join(dir, file)))
      .filter((record): record is VerdictRecord => record?.patchId === pid)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (carried && PASSING.has(carried.verdict)) {
      return {
        pass: true,
        sha,
        line: `${carried.verdict} ${sha} (carried from ${carried.sha}, same patch-id)`,
      };
    }
  }
  return { pass: false, sha, line: `no passing verdict for ${sha}` };
}

export interface PostInput {
  worktree: string;
  sha: string;
  verdict: Verdict;
  summary: string;
  verifier: VerdictRecord["verifier"];
}

/**
 * Records a verdict. Refuses unless the worktree is a linked worktree checked out at the SHA with
 * no tracked edits, so the verdict is about exactly that commit.
 */
export function postVerdict(
  input: PostInput,
  home = verdictHome(),
  now = () => new Date(),
): { ok: true; line: string } | { ok: false; reason: string } {
  const { worktree } = input;
  if (!existsSync(worktree)) return { ok: false, reason: `worktree not found: ${worktree}` };
  const sha = resolveSha(worktree, input.sha);
  if (!sha) return { ok: false, reason: `not a commit in this repository: ${input.sha}` };
  if (tryGit(worktree, ["rev-parse", "HEAD"]) !== sha) {
    return { ok: false, reason: `HEAD is not ${sha}; check the worktree out at the verdict SHA` };
  }
  const gitDir = tryGit(worktree, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = tryGit(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!gitDir || gitDir === commonDir) {
    return {
      ok: false,
      reason:
        'run from a linked worktree (git worktree add --detach "$TMPDIR/verify-<sha>" <sha>), not the main checkout',
    };
  }
  if (hasTrackedEdits(worktree)) {
    return {
      ok: false,
      reason: "the worktree has tracked edits; a verifier never edits the change",
    };
  }
  if (!input.summary.trim()) return { ok: false, reason: "the summary is empty" };
  const record: VerdictRecord = {
    sha,
    verdict: input.verdict,
    patchId: patchId(worktree, sha),
    summary: input.summary,
    verifier: input.verifier,
    at: now().toISOString(),
  };
  const dir = storeDir(worktree, home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sha}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return { ok: true, line: `${input.verdict} recorded for ${sha}` };
}
