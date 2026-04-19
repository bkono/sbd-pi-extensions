import { execFile } from "node:child_process";
import type {
  BeadworkCounts,
  BeadworkCreateIssueInput,
  BeadworkCreateIssueResult,
  BeadworkHistoryEntry,
  BeadworkIssue,
  BeadworkIssueDetail,
  BeadworkListFilters,
  BeadworkUpdateIssueInput,
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
  history(cwd: string, id: string, limit?: number): Promise<BeadworkHistoryEntry[]>;
  createIssue(cwd: string, input: BeadworkCreateIssueInput): Promise<BeadworkCreateIssueResult>;
  updateIssue(cwd: string, id: string, input: BeadworkUpdateIssueInput): Promise<BeadworkIssue>;
  addDependency(cwd: string, blockerId: string, blockedId: string): Promise<void>;
  removeDependency(cwd: string, blockerId: string, blockedId: string): Promise<void>;
  comment(cwd: string, id: string, text: string, author?: string): Promise<BeadworkIssue>;
  label(cwd: string, id: string, operations: string[]): Promise<BeadworkIssue>;
  start(cwd: string, id: string, assignee?: string): Promise<BeadworkIssue>;
  close(cwd: string, id: string, reason?: string): Promise<BeadworkIssue>;
  reopen(cwd: string, id: string): Promise<BeadworkIssue>;
  defer(cwd: string, id: string, when: string): Promise<BeadworkIssue>;
  undefer(cwd: string, id: string): Promise<BeadworkIssue>;
  sync(cwd: string): Promise<void>;
  getCounts(cwd: string, scopeId?: string): Promise<BeadworkCounts>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MUTATION_MAX_ATTEMPTS = 3;
const mutationQueues = new Map<string, Promise<void>>();

function isMovedRefConflict(error: unknown): error is BeadworkCommandError {
  if (!(error instanceof BeadworkCommandError)) {
    return false;
  }

  const detail = `${error.stderr}\n${error.stdout}\n${error.message}`;
  return /ref\s+refs[/\s]heads[/\s]beadwork\s+has\s+moved/i.test(detail);
}

function enqueueMutation<T>(cwd: string, task: () => Promise<T>): Promise<T> {
  const key = cwd;
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(key, tail);
  return result.finally(() => {
    if (mutationQueues.get(key) === tail) {
      mutationQueues.delete(key);
    }
  });
}

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

type RawHistoryEntry = {
  hash?: string;
  timestamp?: string;
  author?: string;
  intent?: string;
  [key: string]: unknown;
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

function normalizeHistoryEntry(input: RawHistoryEntry): BeadworkHistoryEntry {
  const result: BeadworkHistoryEntry = { ...input };
  if (typeof input.hash === "string") {
    result.hash = input.hash;
  }
  if (typeof input.timestamp === "string") {
    result.timestamp = input.timestamp;
  }
  if (typeof input.author === "string") {
    result.author = input.author;
  }
  if (typeof input.intent === "string") {
    result.intent = input.intent;
  }
  return result;
}

function normalizeHistoryEntries(
  input: RawHistoryEntry[] | null | undefined,
): BeadworkHistoryEntry[] {
  return Array.isArray(input) ? input.map(normalizeHistoryEntry) : [];
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

  async function runMutation<T>(cwd: string, task: () => Promise<T>): Promise<T> {
    return enqueueMutation(cwd, async () => {
      let lastConflict: BeadworkCommandError | undefined;

      for (let attempt = 0; attempt < MUTATION_MAX_ATTEMPTS; attempt += 1) {
        if (attempt === MUTATION_MAX_ATTEMPTS - 1 && lastConflict) {
          await run("bw", ["sync"], cwd);
        }

        try {
          return await task();
        } catch (error) {
          if (!isMovedRefConflict(error)) {
            throw error;
          }
          lastConflict = error;
        }
      }

      throw lastConflict ?? new Error("Beadwork mutation retry loop exited unexpectedly.");
    });
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

    async history(cwd, id, limit) {
      const args = ["history", id];
      pushOptionalArg(args, "--limit", limit);
      args.push("--json");
      const entries = await runJson<RawHistoryEntry[] | null>(cwd, args, `history ${id}`);
      return normalizeHistoryEntries(entries);
    },

    async createIssue(cwd, input) {
      return runMutation(cwd, async () => {
        const args = ["create", input.title, "--json"];
        pushOptionalArg(args, "--type", input.type);
        pushOptionalArg(args, "--description", input.description);
        pushOptionalArg(args, "--priority", input.priority);
        pushOptionalArg(args, "--parent", input.parentId);
        const issue = await runJson<RawIssue>(cwd, args, `create ${input.title}`);
        return {
          issue: normalizeIssue(issue),
        };
      });
    },
    async updateIssue(cwd, id, input) {
      return runMutation(cwd, async () => {
        const args = ["update", id, "--json"];
        pushOptionalArg(args, "--title", input.title);
        pushOptionalArg(args, "--description", input.description);
        pushOptionalArg(args, "--priority", input.priority);
        pushOptionalArg(args, "--assignee", input.assignee);
        pushOptionalArg(args, "--type", input.type);
        pushOptionalArg(args, "--status", input.status);
        pushOptionalArg(args, "--defer", input.deferUntil);
        if (input.parentId !== undefined) {
          args.push("--parent", input.parentId ?? "");
        }
        if (input.dueAt !== undefined) {
          args.push("--due", input.dueAt ?? "");
        }
        const issue = await runJson<RawIssue>(cwd, args, `update ${id}`);
        return normalizeIssue(issue);
      });
    },
    async addDependency(cwd, blockerId, blockedId) {
      await runMutation(cwd, () => run("bw", ["dep", "add", blockerId, "blocks", blockedId], cwd));
    },
    async removeDependency(cwd, blockerId, blockedId) {
      await runMutation(cwd, () =>
        run("bw", ["dep", "remove", blockerId, "blocks", blockedId], cwd),
      );
    },
    async comment(cwd, id, text, author) {
      return runMutation(cwd, async () => {
        const args = ["comment", id, text, "--json"];
        pushOptionalArg(args, "--author", author);
        const issue = await runJson<RawIssue>(cwd, args, `comment ${id}`);
        return normalizeIssue(issue);
      });
    },
    async label(cwd, id, operations) {
      if (operations.length === 0) {
        throw new Error("At least one label operation is required.");
      }

      return runMutation(cwd, async () => {
        const issue = await runJson<RawIssue>(
          cwd,
          ["label", id, ...operations, "--json"],
          `label ${id}`,
        );
        return normalizeIssue(issue);
      });
    },
    async start(cwd, id, assignee) {
      return runMutation(cwd, async () => {
        const args = ["start", id, "--json"];
        pushOptionalArg(args, "--assignee", assignee);
        const issue = await runJson<RawIssue>(cwd, args, `start ${id}`);
        return normalizeIssue(issue);
      });
    },
    async close(cwd, id, reason) {
      return runMutation(cwd, async () => {
        const args = ["close", id, "--json"];
        pushOptionalArg(args, "--reason", reason);
        const issue = await runJson<RawIssue>(cwd, args, `close ${id}`);
        return normalizeIssue(issue);
      });
    },
    async reopen(cwd, id) {
      return runMutation(cwd, async () => {
        const issue = await runJson<RawIssue>(cwd, ["reopen", id, "--json"], `reopen ${id}`);
        return normalizeIssue(issue);
      });
    },
    async defer(cwd, id, when) {
      return runMutation(cwd, async () => {
        const issue = await runJson<RawIssue>(cwd, ["defer", id, when, "--json"], `defer ${id}`);
        return normalizeIssue(issue);
      });
    },
    async undefer(cwd, id) {
      return runMutation(cwd, async () => {
        const issue = await runJson<RawIssue>(cwd, ["undefer", id, "--json"], `undefer ${id}`);
        return normalizeIssue(issue);
      });
    },
    async sync(cwd) {
      await runMutation(cwd, () => run("bw", ["sync"], cwd));
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
