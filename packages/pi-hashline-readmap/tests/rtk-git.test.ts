import { describe, expect, it } from "vitest";
import {
  compactDiff,
  compactGitOutput,
  compactLog,
  compactStatus,
  isGitCommand,
} from "../src/rtk/git.js";

describe("isGitCommand", () => {
  it("matches git diff", () => {
    expect(isGitCommand("git diff")).toBe(true);
  });

  it("matches git status", () => {
    expect(isGitCommand("git status")).toBe(true);
  });

  it("matches git log", () => {
    expect(isGitCommand("git log --oneline")).toBe(true);
  });

  it("matches git commands with leading whitespace", () => {
    expect(isGitCommand("  git log --oneline")).toBe(true);
  });

  it("matches git show", () => {
    expect(isGitCommand("git show HEAD")).toBe(true);
  });

  it("matches git stash", () => {
    expect(isGitCommand("git stash list")).toBe(true);
  });

  it("rejects npm install", () => {
    expect(isGitCommand("npm install")).toBe(false);
  });

  it("rejects cargo test", () => {
    expect(isGitCommand("cargo test")).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isGitCommand(undefined)).toBe(false);
  });

  it("rejects null", () => {
    expect(isGitCommand(null)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isGitCommand("")).toBe(false);
  });

  it("rejects compound shell commands so mixed output is not compacted as one git result", () => {
    expect(
      isGitCommand("git status --short; git branch --show-current; git log --oneline -8"),
    ).toBe(false);
    expect(isGitCommand("git status --short && git diff")).toBe(false);
    expect(isGitCommand("git log --format='%h | %s'")).toBe(true);
  });
});

describe("compactDiff", () => {
  it("preserves diff content with file headers", () => {
    const output = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-old line",
      "+new line",
      " line3",
    ].join("\n");

    const result = compactDiff(output);
    expect(result).toContain("src/foo.ts");
    expect(result).toContain("+new line");
    expect(result).toContain("-old line");
  });

  it("truncates large diffs significantly", () => {
    const lines: string[] = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -1,200 +1,200 @@",
    ];
    for (let i = 0; i < 200; i++) {
      lines.push(`+added line ${i}`);
    }
    const output = lines.join("\n");

    const result = compactDiff(output, 20);
    const resultLines = result.split("\n");
    // Should be dramatically smaller than the 200+ input lines
    expect(resultLines.length).toBeLessThan(30);
    expect(result).toContain("more changes");
  });

  it("returns output unchanged when under maxLines", () => {
    const output = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");

    const result = compactDiff(output, 100);
    expect(result).toContain("+new");
    expect(result).toContain("-old");
  });
});

describe("compactStatus", () => {
  it("returns clean for empty output", () => {
    expect(compactStatus("")).toBe("Clean working tree");
  });

  it("shows branch name and staged files", () => {
    const output = ["## main...origin/main", "M  src/foo.ts", "A  src/bar.ts"].join("\n");

    const result = compactStatus(output);
    expect(result).toContain("main");
    expect(result).toContain("Staged");
    expect(result).toContain("2 files");
  });

  it("shows modified files", () => {
    const output = ["## feature", " M src/changed.ts"].join("\n");

    const result = compactStatus(output);
    expect(result).toContain("Modified");
    expect(result).toContain("src/changed.ts");
  });

  it("shows untracked files", () => {
    const output = ["## main", "?? newfile.ts"].join("\n");

    const result = compactStatus(output);
    expect(result).toContain("Untracked");
    expect(result).toContain("newfile.ts");
  });

  it("returns unparseable status-like output unchanged instead of a bare pin header", () => {
    const output = "main\nabc1234 recent commit";
    expect(compactStatus(output)).toBe(output);
  });

  it("summarizes short status output without a branch header when --branch was not used", () => {
    const result = compactStatus(" M src/changed.ts\n?? newfile.ts");
    expect(result).not.toContain("📌");
    expect(result).toContain("Modified");
    expect(result).toContain("Untracked");
  });
});

describe("compactLog", () => {
  it("limits log entries to default 20", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`abc${i}def commit message ${i}`);
    }
    const output = lines.join("\n");

    const result = compactLog(output);
    expect(result).toContain("and 30 more commits");
  });

  it("limits log entries to custom limit", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`commit ${i}`);
    }
    const output = lines.join("\n");

    const result = compactLog(output, 5);
    expect(result).toContain("and 15 more commits");
  });

  it("returns all entries when under limit", () => {
    const output = "commit 1\ncommit 2\ncommit 3";
    const result = compactLog(output, 10);
    expect(result).not.toContain("more commits");
    expect(result).toContain("commit 1");
    expect(result).toContain("commit 3");
  });

  it("truncates long lines to 80 chars", () => {
    const longLine = "a".repeat(100);
    const result = compactLog(longLine);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result).toContain("...");
  });
});

describe("compactGitOutput", () => {
  it("dispatches git diff to compactDiff", () => {
    const output = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");

    const result = compactGitOutput(output, "git diff");
    expect(result).not.toBeNull();
    expect(result).toContain("f.ts");
  });

  it("dispatches git status to compactStatus", () => {
    const result = compactGitOutput("## main\n?? new.ts", "git status --short");
    expect(result).not.toBeNull();
    expect(result).toContain("main");
  });

  it("dispatches git log to compactLog", () => {
    const result = compactGitOutput("commit 1\ncommit 2", "git log --oneline");
    expect(result).not.toBeNull();
    expect(result).toContain("commit 1");
  });

  it("dispatches git commands with leading whitespace", () => {
    const result = compactGitOutput("commit 1\ncommit 2", "  git log --oneline");
    expect(result).not.toBeNull();
    expect(result).toContain("commit 1");
  });

  it("returns null for non-git commands", () => {
    expect(compactGitOutput("output", "npm test")).toBeNull();
  });

  it("returns null for unrecognized git subcommands", () => {
    expect(compactGitOutput("output", "git push origin main")).toBeNull();
  });

  it("returns null for compound git shell commands", () => {
    const output = " M src/foo.ts\nmain\nabc1234 recent commit";
    expect(
      compactGitOutput(
        output,
        "git status --short; git branch --show-current; git log --oneline -8",
      ),
    ).toBeNull();
  });
});
