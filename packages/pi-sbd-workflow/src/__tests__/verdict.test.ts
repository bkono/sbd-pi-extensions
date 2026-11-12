import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkVerdict, postVerdict } from "../verdict.js";
import { cleanupTempDirs, commit, git, makeRepo, tempDir, worktreeAt } from "./git-fixture.js";

afterEach(cleanupTempDirs);

const verifier = { host: "pi", agent: "verifier", model: "anthropic/claude-fable-5-2" };

function post(worktree: string, sha: string, verdict: "PASS" | "FAIL", home: string) {
  return postVerdict({ worktree, sha, verdict, summary: "## Evidence\nran it", verifier }, home);
}

describe("verdicts", () => {
  it("passes a commit only after a passing verdict from its worktree", () => {
    const repo = makeRepo();
    const home = tempDir("sbd-verdicts-");
    const sha = commit(repo, "a.txt", "two\n");
    expect(checkVerdict(repo, "HEAD", home)).toMatchObject({ pass: false });

    const wt = worktreeAt(repo, sha);
    expect(post(wt, sha, "FAIL", home)).toEqual({ ok: true, line: `FAIL recorded for ${sha}` });
    expect(checkVerdict(repo, "HEAD", home)).toEqual({ pass: false, sha, line: `FAIL ${sha}` });

    expect(post(wt, sha, "PASS", home)).toMatchObject({ ok: true });
    expect(checkVerdict(repo, "HEAD", home)).toEqual({ pass: true, sha, line: `PASS ${sha}` });
  });

  it("refuses a verdict from the main checkout, the wrong SHA or an edited tree", () => {
    const repo = makeRepo();
    const home = tempDir("sbd-verdicts-");
    const first = git(repo, "rev-parse", "HEAD");
    const sha = commit(repo, "a.txt", "two\n");

    expect(post(repo, sha, "PASS", home)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("linked worktree"),
    });
    const wt = worktreeAt(repo, first);
    expect(post(wt, sha, "PASS", home)).toMatchObject({
      ok: false,
      reason: expect.stringContaining(`HEAD is not ${sha}`),
    });
    const edited = worktreeAt(repo, sha);
    writeFileSync(join(edited, "a.txt"), "edited\n");
    expect(post(edited, sha, "PASS", home)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("tracked edits"),
    });
    expect(checkVerdict(repo, sha, home).pass).toBe(false);
  });

  it("carries a pass to a rebased commit with the same patch", () => {
    const repo = makeRepo();
    const home = tempDir("sbd-verdicts-");
    git(repo, "checkout", "-q", "-b", "feature");
    const original = commit(repo, "b.txt", "feature\n", "feature");
    expect(post(worktreeAt(repo, original), original, "PASS", home)).toMatchObject({ ok: true });

    git(repo, "checkout", "-q", "main");
    commit(repo, "c.txt", "unrelated\n", "main moves");
    git(repo, "checkout", "-q", "feature");
    git(repo, "rebase", "-q", "main");
    const rebased = git(repo, "rev-parse", "HEAD");
    expect(rebased).not.toBe(original);
    expect(checkVerdict(repo, "HEAD", home)).toEqual({
      pass: true,
      sha: rebased,
      line: `PASS ${rebased} (carried from ${original}, same patch-id)`,
    });

    commit(repo, "b.txt", "different\n", "new behavior");
    expect(checkVerdict(repo, "HEAD", home).pass).toBe(false);
  });

  it("shares one store across the checkout and its worktrees", () => {
    const repo = makeRepo();
    const home = tempDir("sbd-verdicts-");
    const sha = git(repo, "rev-parse", "HEAD");
    const wt = worktreeAt(repo, sha);
    expect(post(wt, sha, "PASS", home)).toMatchObject({ ok: true });
    expect(checkVerdict(wt, "HEAD", home).pass).toBe(true);
    expect(checkVerdict(repo, "HEAD", home).pass).toBe(true);
  });
});
