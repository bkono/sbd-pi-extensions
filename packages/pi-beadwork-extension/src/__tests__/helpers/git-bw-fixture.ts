import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createBeadworkAdapter } from "../../bw.js";
import { REJECTED_SUPERVISOR_ENV_VARS } from "../../config.js";
import type { BeadworkIssue, BeadworkIssueDetail, ReviewPolicy } from "../../types.js";

const execFileAsync = promisify(execFile);

function posixFallbackPath(): string {
  return ["/usr/bin", "/bin"]
    .filter((dir) => !existsSync(path.join(dir, "tmux")))
    .join(path.delimiter);
}

export type FixtureTicketSpec = {
  title: string;
  description?: string;
  type?: string;
  /** Index into `tickets` or an already-created issue id. Applied after create. */
  blockedBy?: number | string;
};

export type GitBwFixtureOptions = {
  prefix?: string;
  reviewPolicy?: ReviewPolicy;
  epicTitle?: string;
  epicDescription?: string;
  tickets?: FixtureTicketSpec[];
};

export type GitBwFixture = {
  cwd: string;
  homeDir: string;
  binDir: string;
  prefix: string;
  reviewPolicy: ReviewPolicy;
  epic: BeadworkIssue;
  tickets: BeadworkIssue[];
  adapter: ReturnType<typeof createBeadworkAdapter>;
  env: IsolatedEnv;
  exec: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  show: (id: string) => Promise<BeadworkIssueDetail>;
  ready: () => Promise<BeadworkIssue[]>;
  worktreePaths: () => Promise<string[]>;
  tmuxOnPath: () => string | undefined;
  dispose: () => Promise<void>;
};

export type IsolatedEnv = {
  previous: NodeJS.ProcessEnv;
  path: string;
  homeDir: string;
  restore: () => void;
};

function whichSync(command: string, envPath: string | undefined): string {
  const dirs = (envPath ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Required binary not found on PATH: ${command}`);
}

export async function snapshotTmuxPids(): Promise<string[]> {
  for (const command of ["/usr/bin/pgrep", "pgrep"] as const) {
    try {
      const { stdout } = await execFileAsync(command, ["-x", "tmux"], {
        encoding: "utf8",
        timeout: 3_000,
      });
      return (stdout ?? "").trim().split("\n").filter(Boolean);
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { code?: number | string };
      if (err.code === "ENOENT") {
        continue;
      }
      // pgrep exits 1 when there are no matches.
      if (err.code === 1) {
        return [];
      }
    }
  }
  return [];
}

function resolveTmuxOnPath(envPath: string): string | undefined {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, "tmux");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function installPathWithoutTmux(binDir: string): Promise<{
  path: string;
  git: string;
  bw: string;
}> {
  mkdirSync(binDir, { recursive: true });
  const sourcePath = process.env.PATH ?? "";
  const git = whichSync("git", sourcePath);
  const bw = whichSync("bw", sourcePath);
  await symlink(git, path.join(binDir, "git"));
  await symlink(bw, path.join(binDir, "bw"));
  const isolated = [binDir, posixFallbackPath()].filter(Boolean).join(path.delimiter);
  if (resolveTmuxOnPath(isolated)) {
    throw new Error(`PATH still contains tmux after isolation: ${isolated}`);
  }
  return { path: isolated, git, bw };
}

function captureEnv(): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    copy[key] = value;
  }
  return copy;
}

function restoreEnv(previous: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearRejectedSupervisorEnv(): void {
  for (const key of REJECTED_SUPERVISOR_ENV_VARS) {
    delete process.env[key];
  }
}

async function exec(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export async function createGitBwFixture(options: GitBwFixtureOptions = {}): Promise<GitBwFixture> {
  const previous = captureEnv();
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-bw-in-process-"));
  const cwd = await realpath(root);
  const homeDir = path.join(cwd, ".home");
  const binDir = path.join(cwd, ".bin");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });

  const isolatedPath = await installPathWithoutTmux(binDir);
  process.env.PATH = isolatedPath.path;
  process.env.HOME = homeDir;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_TEMPLATE_DIR = path.join(cwd, ".git-template");
  mkdirSync(process.env.GIT_TEMPLATE_DIR, { recursive: true });
  clearRejectedSupervisorEnv();

  const env: IsolatedEnv = {
    previous,
    path: isolatedPath.path,
    homeDir,
    restore: () => restoreEnv(previous),
  };

  const prefix = options.prefix ?? "e2e";
  const reviewPolicy: ReviewPolicy = options.reviewPolicy ?? "ticket";
  const run = (command: string, args: string[]) => exec(command, args, cwd, process.env);

  try {
    await writeFile(
      path.join(cwd, ".pi", "beadwork-config.json"),
      `${JSON.stringify({ review: { policy: reviewPolicy } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(cwd, ".pi", "settings.json"),
      `${JSON.stringify(
        { "pi-minions": { allowEphemeral: true, toolSync: { enabled: false } } },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await run("git", ["init", "-q"]);
    await run("git", ["config", "user.email", "in-process@example.com"]);
    await run("git", ["config", "user.name", "In Process Fixture"]);
    await run("git", ["config", "commit.gpgsign", "false"]);
    await writeFile(path.join(cwd, "README.md"), "in-process beadwork fixture\n", "utf8");
    await run("git", ["add", "README.md"]);
    await run("git", ["commit", "-q", "-m", "init"]);
    await run("bw", ["init", "--prefix", prefix]);

    const adapter = createBeadworkAdapter();
    const epicTitle = options.epicTitle ?? "In-process epic";
    const createdEpic = await adapter.createIssue(cwd, {
      title: epicTitle,
      description: options.epicDescription ?? "Epic for in-process orchestration proof.",
      type: "epic",
    });
    const ticketSpecs = options.tickets ?? [
      {
        title: "Implement one in-process ticket",
        description: "Distinct ticket title that must not appear in the /bw run inject prompt.",
      },
    ];
    const tickets: BeadworkIssue[] = [];
    for (const spec of ticketSpecs) {
      const created = await adapter.createIssue(cwd, {
        title: spec.title,
        description: spec.description,
        type: spec.type ?? "task",
        parentId: createdEpic.issue.id,
      });
      tickets.push(created.issue);
    }
    for (let index = 0; index < ticketSpecs.length; index++) {
      const spec = ticketSpecs[index];
      const blocked = tickets[index];
      if (!spec || !blocked || spec.blockedBy === undefined) {
        continue;
      }
      const blockerId =
        typeof spec.blockedBy === "number" ? tickets[spec.blockedBy]?.id : spec.blockedBy;
      if (!blockerId) {
        throw new Error(`blockedBy did not resolve for ticket ${blocked.id}`);
      }
      await adapter.addDependency(cwd, blockerId, blocked.id);
    }

    const epic = await adapter.show(cwd, createdEpic.issue.id);

    const dispose = async () => {
      env.restore();
      rmSync(cwd, { recursive: true, force: true });
    };

    return {
      cwd,
      homeDir,
      binDir,
      prefix,
      reviewPolicy,
      epic,
      tickets,
      adapter,
      env,
      exec: run,
      show: (id) => adapter.show(cwd, id),
      ready: () => adapter.ready(cwd, epic.id),
      worktreePaths: async () => {
        const { stdout } = await run("git", ["worktree", "list", "--porcelain"]);
        return stdout
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice("worktree ".length).trim());
      },
      tmuxOnPath: () => resolveTmuxOnPath(process.env.PATH ?? ""),
      dispose,
    };
  } catch (error) {
    env.restore();
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
}
