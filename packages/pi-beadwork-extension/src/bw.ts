import { execFile } from "node:child_process";
import type {
  BeadworkCounts,
  BeadworkCreateIssueInput,
  BeadworkCreateIssueResult,
  BeadworkIssue,
  BeadworkIssueDetail,
  BeadworkListFilters,
} from "./types.js";

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
};

export type ExecRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

export class BeadworkCommandError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: {
    command: string;
    args: string[];
    cwd?: string;
    code: number;
    stdout?: string;
    stderr?: string;
  }) {
    const rendered = [input.command, ...input.args].join(" ");
    const stderr = input.stderr ?? "";
    const stdout = input.stdout ?? "";
    const detail = stderr.trim() || stdout.trim() || `exit code ${input.code}`;
    super(`Beadwork command failed: ${rendered} (${detail})`);
    this.name = "BeadworkCommandError";
    this.command = input.command;
    this.args = input.args;
    this.cwd = input.cwd;
    this.code = input.code;
    this.stdout = input.stdout ?? "";
    this.stderr = input.stderr ?? "";
  }
}

export interface BeadworkAdapter {
  prime(cwd: string): Promise<string>;
  ready(cwd: string, scopeId?: string): Promise<BeadworkIssue[]>;
  blocked(cwd: string): Promise<BeadworkIssue[]>;
  list(cwd: string, filters?: BeadworkListFilters): Promise<BeadworkIssue[]>;
  show(cwd: string, id: string): Promise<BeadworkIssueDetail>;
  createIssue(cwd: string, input: BeadworkCreateIssueInput): Promise<BeadworkCreateIssueResult>;
  addDependency(cwd: string, blockerId: string, blockedId: string): Promise<void>;
  start(cwd: string, id: string, assignee?: string): Promise<BeadworkIssue>;
  close(cwd: string, id: string, reason?: string): Promise<BeadworkIssue>;
  sync(cwd: string): Promise<void>;
  getCounts(cwd: string, scopeId?: string): Promise<BeadworkCounts>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

type RawIssue = {
  id: string;
  title: string;
  description?: string;
  status?: string;
  type?: string;
  priority?: number;
  labels?: string[];
  blocked_by?: string[];
  blocks?: string[];
  assignee?: string;
  created?: string;
  updated_at?: string;
  parent?: string;
};

function defaultExecRunner(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        const errorCode = typeof error?.code === "number" ? error.code : 0;
        const result = {
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: errorCode,
          killed: false,
        };

        if (error) {
          reject(
            new BeadworkCommandError({
              command,
              args,
              cwd: options.cwd,
              code: typeof error.code === "number" ? error.code : 1,
              stdout: result.stdout,
              stderr: result.stderr,
            }),
          );
          return;
        }

        resolve({ ...result, code: 0 });
      },
    );
  });
}

function normalizeIssue(input: RawIssue): BeadworkIssue {
  return {
    id: input.id,
    title: input.title,
    description: input.description ?? "",
    status: input.status ?? "open",
    type: input.type ?? "task",
    priority: typeof input.priority === "number" ? input.priority : 2,
    labels: Array.isArray(input.labels) ? input.labels : [],
    blockedBy: Array.isArray(input.blocked_by) ? input.blocked_by : [],
    blocks: Array.isArray(input.blocks) ? input.blocks : [],
    assignee: input.assignee ?? "",
    createdAt: input.created ?? "",
    updatedAt: input.updated_at ?? input.created ?? "",
    parentId:
      typeof input.parent === "string" && input.parent.length > 0 ? input.parent : undefined,
  };
}

function normalizeIssueArray(input: RawIssue[] | null | undefined): BeadworkIssue[] {
  return Array.isArray(input) ? input.map(normalizeIssue) : [];
}

function parseJson<T>(value: string, context: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Failed to parse beadwork JSON for ${context}: ${String(error)}`);
  }
}

function pushOptionalArg(args: string[], flag: string, value: string | number | undefined): void {
  if (value === undefined || value === "") {
    return;
  }
  args.push(flag, String(value));
}

function formatListFilters(filters?: BeadworkListFilters): string[] {
  if (!filters) {
    return ["--all", "--json"];
  }

  const args: string[] = [];
  pushOptionalArg(args, "--status", filters.status);
  pushOptionalArg(args, "--type", filters.type);
  pushOptionalArg(args, "--parent", filters.parent);
  pushOptionalArg(args, "--priority", filters.priority);
  pushOptionalArg(args, "--assignee", filters.assignee);
  pushOptionalArg(args, "--grep", filters.grep);
  pushOptionalArg(args, "--limit", filters.limit);
  if (filters.all) {
    args.push("--all");
  }
  if (filters.deferred) {
    args.push("--deferred");
  }
  if (filters.overdue) {
    args.push("--overdue");
  }
  args.push("--json");
  return args;
}

export function createBeadworkAdapter(execRunner: ExecRunner = defaultExecRunner): BeadworkAdapter {
  async function run(command: string, args: string[], cwd: string): Promise<ExecResult> {
    return execRunner(command, args, { cwd, timeout: DEFAULT_TIMEOUT_MS });
  }

  async function runJson<T>(cwd: string, args: string[], context: string): Promise<T> {
    const result = await run("bw", args, cwd);
    return parseJson<T>(result.stdout, context);
  }

  return {
    async prime(cwd) {
      const result = await run("bw", ["prime"], cwd);
      return result.stdout.trim();
    },

    async ready(cwd, scopeId) {
      const args = ["ready"];
      if (scopeId) {
        args.push(scopeId);
      }
      args.push("--json");
      const items = await runJson<RawIssue[] | null>(cwd, args, "ready");
      return normalizeIssueArray(items);
    },

    async blocked(cwd) {
      const items = await runJson<RawIssue[] | null>(cwd, ["blocked", "--json"], "blocked");
      return normalizeIssueArray(items);
    },

    async list(cwd, filters) {
      const items = await runJson<RawIssue[] | null>(
        cwd,
        ["list", ...formatListFilters(filters)],
        "list",
      );
      return normalizeIssueArray(items);
    },

    async show(cwd, id) {
      const [issue, children] = await Promise.all([
        runJson<RawIssue>(cwd, ["show", id, "--json"], `show ${id}`),
        runJson<RawIssue[] | null>(
          cwd,
          ["list", "--all", "--parent", id, "--json"],
          `children ${id}`,
        ),
      ]);

      return {
        ...normalizeIssue(issue),
        children: normalizeIssueArray(children),
      };
    },

    async createIssue(cwd, input) {
      const args = ["create", input.title, "--json"];
      pushOptionalArg(args, "--type", input.type);
      pushOptionalArg(args, "--description", input.description);
      pushOptionalArg(args, "--priority", input.priority);
      pushOptionalArg(args, "--parent", input.parentId);
      const issue = await runJson<RawIssue>(cwd, args, `create ${input.title}`);
      return {
        issue: normalizeIssue(issue),
      };
    },

    async addDependency(cwd, blockerId, blockedId) {
      await run("bw", ["dep", "add", blockerId, "blocks", blockedId], cwd);
    },

    async start(cwd, id, assignee) {
      const args = ["start", id, "--json"];
      pushOptionalArg(args, "--assignee", assignee);
      const issue = await runJson<RawIssue>(cwd, args, `start ${id}`);
      return normalizeIssue(issue);
    },

    async close(cwd, id, reason) {
      const args = ["close", id, "--json"];
      pushOptionalArg(args, "--reason", reason);
      const issue = await runJson<RawIssue>(cwd, args, `close ${id}`);
      return normalizeIssue(issue);
    },

    async sync(cwd) {
      await run("bw", ["sync"], cwd);
    },

    async getCounts(cwd, scopeId) {
      const [ready, blocked, inProgress] = await Promise.all([
        this.ready(cwd, scopeId),
        this.blocked(cwd),
        this.list(cwd, { status: "in_progress", all: true }),
      ]);

      return {
        ready: ready.length,
        blocked: blocked.length,
        inProgress: inProgress.length,
        scopedReady: scopeId ? ready.length : undefined,
      };
    },
  };
}
