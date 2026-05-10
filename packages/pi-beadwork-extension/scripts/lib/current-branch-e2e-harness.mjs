import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let activeHarness;
const harnessFile = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(harnessFile), "../..");
const repoRoot = path.resolve(packageRoot, "../..");

export const ROOTS = {
  packageRoot,
  repoRoot,
};

export function createId(prefix) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `${stamp}-${process.pid}-${prefix}`;
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function resolveExecutionMode({
  env = process.env,
  config = {},
  defaultMode = "worktree",
} = {}) {
  const envMode = env.PI_BEADWORK_WORKER_EXECUTION_MODE ?? env.PI_BEADWORK_E2E_WORKER_MODE;
  if (envMode === "current-branch" || envMode === "worktree") {
    return { mode: envMode, source: "env" };
  }

  const configMode = config.workerExecution?.mode;
  if (configMode === "current-branch" || configMode === "worktree") {
    return { mode: configMode, source: "config" };
  }

  return { mode: defaultMode, source: "default" };
}

export async function packageDefaultExecutionMode() {
  const constantsPath = path.join(packageRoot, "src/constants.ts");
  const source = await readFile(constantsPath, "utf8");
  const match = source.match(/workerExecution:\s*{[\s\S]*?mode:\s*"([^"]+)"/);
  return match?.[1] ?? "unknown";
}

export class E2eHarness {
  constructor({
    scenario,
    artifactGroup,
    seed = process.env.PI_BEADWORK_E2E_SEED ?? "sbdpi-qmd.5.6",
  }) {
    this.scenario = scenario;
    this.artifactGroup = artifactGroup;
    this.seed = seed;
    this.runId = createId(scenario);
    this.startedAt = new Date();
    this.artifactDir = path.join(packageRoot, "tmp", artifactGroup, this.runId);
    this.tempRoot = this.artifactDir;
    this.commandsDir = path.join(this.artifactDir, "commands");
    this.promptsDir = path.join(this.artifactDir, "prompts");
    this.snapshotsDir = path.join(this.artifactDir, "snapshots");
    this.validationDir = path.join(this.artifactDir, "validation");
    this.repoDir = path.join(this.artifactDir, "repo");
    this.commandIndex = 0;
    this.commands = [];
    this.artifacts = [];
    this.failures = [];
    this.timings = [];
    this.coverage = new Set();
    this.eventsPath = path.join(this.artifactDir, "events.jsonl");
    activeHarness = this;
  }

  async init() {
    await mkdir(this.commandsDir, { recursive: true });
    await mkdir(this.promptsDir, { recursive: true });
    await mkdir(this.snapshotsDir, { recursive: true });
    await mkdir(this.validationDir, { recursive: true });
    await this.event("run.start", {
      scenario: this.scenario,
      runId: this.runId,
      artifactDir: this.artifactDir,
      seed: this.seed,
      node: process.version,
      platform: os.platform(),
    });
    console.log(`[${this.scenario}] run ${this.runId}`);
    console.log(`[${this.scenario}] artifacts ${this.artifactDir}`);
  }

  async event(type, data = {}) {
    const event = {
      ts: new Date().toISOString(),
      type,
      scenario: this.scenario,
      ...data,
    };
    await mkdir(path.dirname(this.eventsPath), { recursive: true });
    await writeFile(this.eventsPath, `${JSON.stringify(event)}\n`, { flag: "a" });
    this.artifacts.push(this.eventsPath);
    return event;
  }

  async step(name, data = {}) {
    console.log(`[${this.scenario}] ${name}`);
    await this.event("step", { name, ...data });
  }

  cover(id) {
    this.coverage.add(id);
  }

  assert(condition, message, details = {}) {
    if (!condition) {
      const failure = { message, details };
      this.failures.push(failure);
      throw new Error(`${message}: ${JSON.stringify(details)}`);
    }
  }

  async writeArtifact(relativePath, contents) {
    const absolutePath = path.join(this.artifactDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(
      absolutePath,
      typeof contents === "string" ? contents : stableJson(contents),
      "utf8",
    );
    this.artifacts.push(absolutePath);
    return absolutePath;
  }

  async writePrompt(name, contents) {
    return this.writeArtifact(path.join("prompts", `${name}.md`), contents.trimEnd() + "\n");
  }

  async fakeCommand(kind, label, payload, result = { exitCode: 0, stdout: "ok", stderr: "" }) {
    const index = String(++this.commandIndex).padStart(3, "0");
    const slug = label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "");
    const base = path.join(this.commandsDir, `${index}-${kind}-${slug}`);
    const record = {
      index: this.commandIndex,
      kind,
      label,
      cwd: this.repoDir,
      command: `${kind} ${label}`,
      args: payload,
      exitCode: result.exitCode ?? 0,
      durationMs: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      stdoutPath: `${base}.stdout.log`,
      stderrPath: `${base}.stderr.log`,
    };
    await writeFile(record.stdoutPath, result.stdout ?? "", "utf8");
    await writeFile(record.stderrPath, result.stderr ?? "", "utf8");
    await writeFile(`${base}.json`, stableJson(record), "utf8");
    this.commands.push(record);
    this.artifacts.push(record.stdoutPath, record.stderrPath, `${base}.json`);
    await this.event("command", { kind, label, exitCode: record.exitCode, log: `${base}.json` });
    return record;
  }

  async command(label, cwd, command, args = [], options = {}) {
    const index = String(++this.commandIndex).padStart(3, "0");
    const slug = label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "");
    const base = path.join(this.commandsDir, `${index}-${slug}`);
    const startedAt = new Date();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let error;

    try {
      const result = await execFileAsync(command, args, {
        cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (caught) {
      error = caught;
      stdout = caught.stdout ?? "";
      stderr = caught.stderr ?? caught.message;
      exitCode = caught.code ?? 1;
    }

    const finishedAt = new Date();
    const record = {
      index: this.commandIndex,
      label,
      cwd,
      command,
      args,
      exitCode,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      stdoutPath: `${base}.stdout.log`,
      stderrPath: `${base}.stderr.log`,
    };
    await writeFile(record.stdoutPath, stdout, "utf8");
    await writeFile(record.stderrPath, stderr, "utf8");
    await writeFile(`${base}.json`, stableJson(record), "utf8");
    this.commands.push(record);
    this.artifacts.push(record.stdoutPath, record.stderrPath, `${base}.json`);
    this.timings.push({ label, durationMs: record.durationMs, exitCode });
    await this.event("command", { label, command, args, exitCode, log: `${base}.json` });

    if (exitCode !== 0 && !options.allowFailure) {
      const failure = {
        label,
        command,
        args,
        exitCode,
        stdoutTail: stdout.slice(-2000),
        stderrTail: stderr.slice(-2000),
      };
      this.failures.push(failure);
      throw error ?? new Error(`${command} ${args.join(" ")} exited ${exitCode}`);
    }

    return { ...record, stdout, stderr };
  }

  async initGitRepo() {
    await mkdir(this.repoDir, { recursive: true });
    await this.command("git-init", this.repoDir, "git", ["init", "-b", "main"]);
    await this.command("git-config-user-email", this.repoDir, "git", [
      "config",
      "user.email",
      "pi-beadwork-e2e@example.invalid",
    ]);
    await this.command("git-config-user-name", this.repoDir, "git", [
      "config",
      "user.name",
      "Pi Beadwork E2E",
    ]);
    await this.writeRepoFile("README.md", "# Beadwork E2E fixture\n");
    await this.writeRepoFile(
      "package.json",
      stableJson({
        name: "pi-beadwork-e2e-fixture",
        private: true,
        scripts: {
          lint: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"',
          typecheck: 'node -e "process.exit(0)"',
        },
      }),
    );
    await this.command("git-add-initial", this.repoDir, "git", [
      "add",
      "README.md",
      "package.json",
    ]);
    await this.command("git-commit-initial", this.repoDir, "git", [
      "commit",
      "-m",
      "chore: initialize e2e fixture",
    ]);
    return this.repoDir;
  }

  async initBeadwork(prefix = `e2e${shortHash(this.runId).slice(0, 6)}`) {
    await this.command("bw-init", this.repoDir, "bw", ["init", "--prefix", prefix]);
    await this.snapshotGit("after-bw-init");
    return prefix;
  }

  async bw(label, args, options = {}) {
    return this.command(`bw-${label}`, this.repoDir, "bw", args, options);
  }

  async bwCreate(title, { type = "task", priority = "1", description, parent } = {}) {
    const args = ["create", title, "--type", type, "--priority", String(priority), "--silent"];
    if (description) {
      args.push("--description", description);
    }
    if (parent) {
      args.push("--parent", parent);
    }
    const result = await this.bw(`create-${shortHash(title)}`, args);
    return result.stdout.trim();
  }

  async snapshotBwCli(name, ticketIds = []) {
    await this.bw(`${name}-ready-json`, ["ready", "--json"], { allowFailure: true });
    for (const ticketId of ticketIds) {
      await this.bw(`${name}-show-${ticketId}`, ["show", ticketId, "--json"], {
        allowFailure: true,
      });
      await this.bw(`${name}-history-${ticketId}`, ["history", ticketId, "--json"], {
        allowFailure: true,
      });
    }
  }

  async writeRepoFile(relativePath, contents, repoDir = this.repoDir) {
    const absolutePath = path.join(repoDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
    return absolutePath;
  }

  async appendRepoFile(relativePath, contents, repoDir = this.repoDir) {
    const absolutePath = path.join(repoDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, { flag: "a" });
    return absolutePath;
  }

  async gitCommit(ticketId, files, message, repoDir = this.repoDir) {
    await this.command(`git-add-${ticketId}`, repoDir, "git", ["add", ...files]);
    await this.command(`git-commit-${ticketId}`, repoDir, "git", [
      "commit",
      "-m",
      `${message}\n\nTicket: ${ticketId}`,
    ]);
    const rev = await this.command(`git-rev-${ticketId}`, repoDir, "git", [
      "rev-parse",
      "--short=12",
      "HEAD",
    ]);
    return rev.stdout.trim();
  }

  async snapshotRegistry(name, registry) {
    await this.writeArtifact(path.join("snapshots", `${name}-registry.json`), registry);
    await this.event("registry.snapshot", { name, workers: registry.workers?.length ?? 0 });
  }

  async snapshotBw(name, tickets, histories = {}) {
    const ready = tickets.filter((ticket) => ticket.status === "open" && !ticket.blockedBy?.length);
    await this.writeArtifact(path.join("snapshots", `${name}-bw-ready.json`), ready);
    for (const ticket of tickets) {
      await this.writeArtifact(path.join("snapshots", `${name}-bw-show-${ticket.id}.json`), ticket);
      await this.writeArtifact(
        path.join("snapshots", `${name}-bw-history-${ticket.id}.json`),
        histories[ticket.id] ?? [],
      );
    }
    await this.fakeCommand(
      "bw",
      `${name}-ready`,
      { ready: ready.map((ticket) => ticket.id) },
      { stdout: stableJson(ready) },
    );
  }

  async snapshotGit(name, repoDir = this.repoDir) {
    await this.command(`${name}-git-status`, repoDir, "git", ["status", "--porcelain"]);
    await this.command(`${name}-git-log`, repoDir, "git", [
      "log",
      "--oneline",
      "--decorate",
      "--max-count=20",
    ]);
    const head = await this.command(`${name}-git-head`, repoDir, "git", [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    await this.command(`${name}-git-show-stat`, repoDir, "git", [
      "show",
      "--stat",
      "--oneline",
      head.stdout.trim(),
    ]);
  }

  async validation(name, cwd, command, args = [], options = {}) {
    const record = await this.command(`validation-${name}`, cwd, command, args, options);
    const validation = {
      name,
      command,
      args,
      cwd,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      stdoutPath: record.stdoutPath,
      stderrPath: record.stderrPath,
    };
    await this.writeArtifact(path.join("validation", `${name}.json`), validation);
    return validation;
  }

  async removeWorktree(worktreeDir) {
    const exists = await stat(worktreeDir).then(
      () => true,
      () => false,
    );
    if (exists) {
      await this.command("git-worktree-remove", this.repoDir, "git", [
        "worktree",
        "remove",
        "--force",
        worktreeDir,
      ]);
    } else {
      await rm(worktreeDir, { recursive: true, force: true });
    }
  }

  async finalize(status, extra = {}) {
    const finishedAt = new Date();
    await this.event("run.finish", { status, failures: this.failures.length });
    const summary = {
      scenario: this.scenario,
      status,
      runId: this.runId,
      seed: this.seed,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      artifactDir: this.artifactDir,
      repoPath: this.repoDir,
      coverage: Array.from(this.coverage).sort(),
      commands: this.commands,
      timings: this.timings,
      artifacts: Array.from(new Set(this.artifacts)).sort(),
      failures: this.failures,
      ...extra,
    };
    await this.writeArtifact("summary.json", summary);
    await this.writeReport(summary);
    console.log(`[${this.scenario}] ${status}`);
    console.log(`[${this.scenario}] summary ${path.join(this.artifactDir, "summary.json")}`);
    console.log(`[${this.scenario}] report ${path.join(this.artifactDir, "report.md")}`);
    return summary;
  }

  async writeReport(summary) {
    const lines = [
      `# ${this.scenario} e2e report`,
      "",
      `- status: ${summary.status}`,
      `- run id: ${summary.runId}`,
      `- artifact dir: ${summary.artifactDir}`,
      `- repo path: ${summary.repoPath}`,
      `- duration: ${summary.durationMs}ms`,
      `- covered scenarios: ${summary.coverage.join(", ") || "none"}`,
      "",
      "## Commands",
      "",
      ...summary.commands.map(
        (command) =>
          `- ${command.index}. ${command.label ?? command.kind} (${command.exitCode}) ${command.command ?? "fake"} ${(command.args ?? []).join?.(" ") ?? ""}`,
      ),
      "",
      "## Failures",
      "",
      ...(summary.failures.length
        ? summary.failures.map(
            (failure) =>
              `- ${failure.message ?? failure.label}: ${JSON.stringify(failure.details ?? failure)}`,
          )
        : ["None"]),
      "",
      "## Artifacts",
      "",
      `- summary: ${path.join(this.artifactDir, "summary.json")}`,
      `- events: ${this.eventsPath}`,
      `- commands: ${this.commandsDir}`,
      `- prompts: ${this.promptsDir}`,
      `- snapshots: ${this.snapshotsDir}`,
      `- validation: ${this.validationDir}`,
    ];
    await this.writeArtifact("report.md", `${lines.join("\n")}\n`);
  }
}

export async function runScenario(main) {
  let harness;
  try {
    harness = await main();
    await harness.finalize("passed");
  } catch (error) {
    const failedHarness = harness ?? activeHarness;
    if (failedHarness) {
      await failedHarness.event("run.error", { message: error.message, stack: error.stack });
      const summary = await failedHarness.finalize("failed", {
        error: { message: error.message, stack: error.stack },
      });
      console.error(`[${failedHarness.scenario}] failed: ${error.message}`);
      console.error(`[${failedHarness.scenario}] artifacts ${summary.artifactDir}`);
    }
    process.exitCode = 1;
  }
}
