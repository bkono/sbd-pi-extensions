import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { tokenizeArgs } from "./argv.js";
import type { BeadworkAdapter } from "./bw.js";
import { BEADWORK_ALIAS_COMMANDS, type BeadworkAliasSubcommand } from "./command-aliases.js";
import type { ActivationState, BeadworkIssue, WorkerRuntime } from "./types.js";

const MAIN_COMMANDS: Array<{
  value: string;
  label: string;
  description: string;
}> = [
  { value: "status", label: "status", description: "Show activation, mode, counts, and scope" },
  { value: "ready", label: "ready", description: "List ready work" },
  { value: "list", label: "list", description: "List beadwork issues" },
  { value: "show", label: "show", description: "Show one issue" },
  { value: "scope", label: "scope", description: "Set or clear scope" },
  { value: "workers", label: "workers", description: "Inspect workers" },
  { value: "delegate", label: "delegate", description: "Delegate a ticket" },
  { value: "land", label: "land", description: "Land a worker" },
  { value: "cancel", label: "cancel", description: "Cancel an active worker" },
  { value: "cleanup", label: "cleanup", description: "Cleanup landed worker artifacts" },
  { value: "run", label: "run", description: "Run a bounded epic loop" },
  { value: "off", label: "off", description: "Reset the session" },
  { value: "adopt", label: "adopt", description: "Adopt a markdown plan" },
  { value: "engage", label: "engage", description: "Enter interactive beadwork mode" },
  { value: "prime", label: "prime", description: "Show cached bw prime guidance" },
  { value: "blocked", label: "blocked", description: "Show blocked work" },
  { value: "history", label: "history", description: "Show issue history" },
  { value: "create", label: "create", description: "Create an issue" },
  { value: "update", label: "update", description: "Update an issue" },
  { value: "dep", label: "dep", description: "Manage dependencies" },
  { value: "start", label: "start", description: "Run bw start" },
  { value: "close", label: "close", description: "Run bw close" },
  { value: "reopen", label: "reopen", description: "Reopen an issue" },
  { value: "comment", label: "comment", description: "Add a comment" },
  { value: "label", label: "label", description: "Mutate labels" },
  { value: "defer", label: "defer", description: "Defer an issue" },
  { value: "undefer", label: "undefer", description: "Restore a deferred issue" },
  { value: "sync", label: "sync", description: "Run bw sync" },
];

const OPTION_COMPLETIONS: Record<string, AutocompleteItem[]> = {
  list: [
    { value: "--all", label: "--all", description: "Include all statuses" },
    { value: "--status", label: "--status", description: "Filter by status" },
    { value: "--type", label: "--type", description: "Filter by issue type" },
    { value: "--parent", label: "--parent", description: "Filter by parent issue" },
    { value: "--priority", label: "--priority", description: "Filter by priority" },
    { value: "--assignee", label: "--assignee", description: "Filter by assignee" },
    { value: "--grep", label: "--grep", description: "Search title/description" },
    { value: "--limit", label: "--limit", description: "Limit result count" },
    { value: "--deferred", label: "--deferred", description: "Only deferred issues" },
    { value: "--overdue", label: "--overdue", description: "Only overdue issues" },
  ],
  delegate: [{ value: "--model", label: "--model", description: "Override worker model" }],
  run: [
    { value: "--workers", label: "--workers", description: "Set worker count" },
    { value: "--until", label: "--until", description: "Stop when blocked or empty" },
    { value: "--max-cycles", label: "--max-cycles", description: "Limit run cycles" },
    { value: "--dry-run", label: "--dry-run", description: "Preview without spawning" },
    { value: "--no-spawn", label: "--no-spawn", description: "Do not launch new workers" },
  ],
  off: [
    { value: "--stop-workers", label: "--stop-workers", description: "Stop active workers first" },
    {
      value: "--all-workers",
      label: "--all-workers",
      description: "Stop workers across all epics",
    },
    {
      value: "--leave-workers",
      label: "--leave-workers",
      description: "Reset session but keep workers running",
    },
  ],
  adopt: [
    { value: "--file", label: "--file", description: "Read markdown from a file" },
    { value: "--title", label: "--title", description: "Override root title" },
    { value: "--land", label: "--land", description: "Choose quick, branch, or multi" },
    { value: "--apply", label: "--apply", description: "Apply the adoption plan" },
  ],
  cleanup: [],
  cancel: [],
  land: [],
  show: [],
  history: [],
  scope: [],
  ready: [],
  status: [],
  workers: [],
};

export type CompletionFactoryDeps = {
  adapter: Pick<BeadworkAdapter, "ready" | "list">;
  detectActivation: (cwd: string) => Promise<ActivationState>;
  getCwd?: () => string;
  getWorkers?: () => Promise<WorkerRuntime[]>;
};

function filterItems(prefix: string, items: AutocompleteItem[]): AutocompleteItem[] | null {
  const filtered = items.filter((item) => item.value.startsWith(prefix));
  return filtered.length > 0 ? filtered : null;
}

function splitCommandPrefix(prefix: string): {
  commandPrefix: string;
  remainderPrefix: string;
  hasSubcommand: boolean;
} {
  const trimmedStart = prefix.trimStart();
  if (trimmedStart.length === 0) {
    return { commandPrefix: "", remainderPrefix: "", hasSubcommand: false };
  }

  const tokens = tokenizeArgs(trimmedStart);
  const first = tokens[0] ?? "";
  if (!first) {
    return { commandPrefix: "", remainderPrefix: "", hasSubcommand: false };
  }

  const firstMatch = trimmedStart.match(/^\S+/)?.[0] ?? first;
  const remainderPrefix = trimmedStart.slice(firstMatch.length).trimStart();
  const hasSubcommand = /\s$/.test(prefix) || remainderPrefix.length > 0;
  return { commandPrefix: first, remainderPrefix, hasSubcommand };
}

async function listIssueCandidates(
  deps: CompletionFactoryDeps,
  selector: (issues: BeadworkIssue[]) => BeadworkIssue[],
): Promise<AutocompleteItem[] | null> {
  const cwd = deps.getCwd?.() ?? process.cwd();
  const activation = await deps.detectActivation(cwd);
  if (activation.kind !== "active") {
    return null;
  }

  const issues = selector(await deps.adapter.list(cwd, { all: true, limit: 25 }));
  if (issues.length === 0) {
    return null;
  }

  return issues.map((issue) => ({
    value: issue.id,
    label: `${issue.id} · ${issue.type}`,
    description: issue.title,
  }));
}

async function readyTicketItems(deps: CompletionFactoryDeps): Promise<AutocompleteItem[] | null> {
  const cwd = deps.getCwd?.() ?? process.cwd();
  const activation = await deps.detectActivation(cwd);
  if (activation.kind !== "active") {
    return null;
  }

  const ready = (await deps.adapter.ready(cwd)).filter((issue) => issue.type !== "epic");
  if (ready.length === 0) {
    return null;
  }

  return ready.map((issue) => ({
    value: issue.id,
    label: `${issue.id} · ${issue.status}`,
    description: issue.title,
  }));
}

async function epicItems(deps: CompletionFactoryDeps): Promise<AutocompleteItem[] | null> {
  return listIssueCandidates(deps, (issues) => issues.filter((issue) => issue.type === "epic"));
}

async function issueItems(deps: CompletionFactoryDeps): Promise<AutocompleteItem[] | null> {
  return listIssueCandidates(deps, (issues) => issues);
}

async function workerItems(
  deps: CompletionFactoryDeps,
  predicate: (worker: WorkerRuntime) => boolean,
): Promise<AutocompleteItem[] | null> {
  const workers = deps.getWorkers ? (await deps.getWorkers()).filter(predicate) : [];
  if (workers.length === 0) {
    return null;
  }

  return workers.map((worker) => ({
    value: worker.ticketId,
    label: `${worker.ticketId} · ${worker.status}`,
    description: worker.workerId,
  }));
}

export function createBeadworkCommandCompletionFactory(deps: CompletionFactoryDeps): {
  getMainCommandCompletions: (prefix: string) => Promise<AutocompleteItem[] | null>;
  getAliasCommandCompletions: (
    subcommand: BeadworkAliasSubcommand,
    prefix: string,
  ) => Promise<AutocompleteItem[] | null>;
} {
  async function getAliasCommandCompletions(
    subcommand: BeadworkAliasSubcommand,
    prefix: string,
  ): Promise<AutocompleteItem[] | null> {
    const trimmed = prefix.trimStart();
    if (trimmed.startsWith("--")) {
      return filterItems(trimmed, OPTION_COMPLETIONS[subcommand] ?? []);
    }

    switch (subcommand) {
      case "delegate":
        return filterItems(trimmed, (await readyTicketItems(deps)) ?? []);
      case "run":
        return filterItems(trimmed, (await epicItems(deps)) ?? []);
      case "show":
      case "scope":
      case "ready":
        return filterItems(trimmed, (await issueItems(deps)) ?? []);
      case "land":
        return filterItems(
          trimmed,
          (await workerItems(
            deps,
            (worker) =>
              worker.status === "held" ||
              worker.status === "attention" ||
              worker.status === "exited",
          )) ?? [],
        );
      case "cancel":
        return filterItems(
          trimmed,
          (await workerItems(
            deps,
            (worker) => worker.status === "launching" || worker.status === "running",
          )) ?? [],
        );
      case "cleanup":
        return filterItems(
          trimmed,
          (await workerItems(
            deps,
            (worker) => worker.status === "landed" && worker.cleanupStatus !== "cleaned",
          )) ?? [],
        );
      default:
        return filterItems(trimmed, OPTION_COMPLETIONS[subcommand] ?? []);
    }
  }

  async function getMainCommandCompletions(prefix: string): Promise<AutocompleteItem[] | null> {
    const { commandPrefix, remainderPrefix, hasSubcommand } = splitCommandPrefix(prefix);
    if (!hasSubcommand) {
      return filterItems(
        commandPrefix,
        MAIN_COMMANDS.map((command) => ({
          value: command.value,
          label: command.label,
          description: command.description,
        })),
      );
    }

    const alias = BEADWORK_ALIAS_COMMANDS.find(
      (candidate) => candidate.subcommand === commandPrefix,
    );
    if (!alias) {
      return null;
    }

    return getAliasCommandCompletions(alias.subcommand, remainderPrefix);
  }

  return { getMainCommandCompletions, getAliasCommandCompletions };
}
