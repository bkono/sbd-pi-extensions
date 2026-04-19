import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ParsedArgv } from "../argv.js";
import type { BeadworkAdapter } from "../bw.js";
import {
  showHistory,
  showIssue,
  showIssueList,
  showMutationResult,
  showReady,
} from "../commands.js";
import type {
  ActivationState,
  BeadworkConfig,
  BeadworkListFilters,
  BeadworkUpdateIssueInput,
  SessionState,
} from "../types.js";

function readStringOption(options: Map<string, string | true>, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === "string" ? value : undefined;
}

function readNumberOption(options: Map<string, string | true>, key: string): number | undefined {
  const value = readStringOption(options, key);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric value for --${key}: ${value}`);
  }

  return parsed;
}

function buildListFilters(options: Map<string, string | true>): BeadworkListFilters {
  return {
    status: readStringOption(options, "status"),
    type: readStringOption(options, "type"),
    parent: readStringOption(options, "parent"),
    priority: readNumberOption(options, "priority"),
    assignee: readStringOption(options, "assignee"),
    grep: readStringOption(options, "grep"),
    limit: readNumberOption(options, "limit"),
    all: options.has("all"),
    deferred: options.has("deferred"),
    overdue: options.has("overdue"),
  };
}

function buildUpdateInput(options: Map<string, string | true>): BeadworkUpdateIssueInput {
  const clearParent = options.has("clear-parent");
  const clearDue = options.has("clear-due");

  return {
    title: readStringOption(options, "title"),
    description: readStringOption(options, "description"),
    priority: readNumberOption(options, "priority"),
    assignee: readStringOption(options, "assignee"),
    type: readStringOption(options, "type"),
    status: readStringOption(options, "status"),
    parentId: clearParent ? null : readStringOption(options, "parent"),
    deferUntil: readStringOption(options, "defer"),
    dueAt: clearDue ? null : readStringOption(options, "due"),
  };
}

function hasIssueUpdate(input: BeadworkUpdateIssueInput): boolean {
  return (
    input.title !== undefined ||
    input.description !== undefined ||
    input.priority !== undefined ||
    input.assignee !== undefined ||
    input.type !== undefined ||
    input.status !== undefined ||
    input.parentId !== undefined ||
    input.deferUntil !== undefined ||
    input.dueAt !== undefined
  );
}

function normalizeDependencyPair(args: string[]): { blockerId: string; blockedId: string } | null {
  if (args.length < 2) {
    return null;
  }

  const [first, second, third] = args;
  if (second === "blocks") {
    if (!first || !third) {
      return null;
    }
    return { blockerId: first, blockedId: third };
  }

  if (!first || !second) {
    return null;
  }

  return { blockerId: first, blockedId: second };
}

export type IssuesActionDeps = {
  adapter: BeadworkAdapter;
  requireActive: (ctx: ExtensionCommandContext) => Promise<{
    activation: ActivationState;
    config: BeadworkConfig;
    state: SessionState;
  } | null>;
};

export async function handleIssuesAction(input: {
  subcommand: string;
  parsed: ParsedArgv;
  ctx: ExtensionCommandContext;
  deps: IssuesActionDeps;
}): Promise<boolean> {
  const { subcommand, parsed, ctx, deps } = input;

  if (subcommand === "ready") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const scopeId =
      parsed.positional[0] ??
      (active.state.scope.kind === "none" ? undefined : active.state.scope.id);
    const ready = await deps.adapter.ready(ctx.cwd, scopeId);
    await showReady(ctx, ready, scopeId);
    return true;
  }

  if (subcommand === "blocked") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const blocked = await deps.adapter.blocked(ctx.cwd);
    await showIssueList(ctx, blocked, "Blocked work:");
    return true;
  }

  if (subcommand === "list") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const filters = buildListFilters(parsed.options);
    const issues = await deps.adapter.list(ctx.cwd, filters);
    await showIssueList(ctx, issues, "Issue list:");
    return true;
  }

  if (subcommand === "history") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const issueId = parsed.positional[0];
    if (!issueId) {
      ctx.ui.notify("Usage: /bw history <issue-id> [--limit n]", "info");
      return true;
    }

    const entries = await deps.adapter.history(
      ctx.cwd,
      issueId,
      readNumberOption(parsed.options, "limit"),
    );
    await showHistory(ctx, issueId, entries);
    return true;
  }

  if (subcommand === "show") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const issueId =
      parsed.positional[0] ??
      (active.state.scope.kind === "none" ? undefined : active.state.scope.id);
    if (!issueId) {
      ctx.ui.notify("Usage: /bw show <issue-id>", "info");
      return true;
    }

    const issue = await deps.adapter.show(ctx.cwd, issueId);
    await showIssue(ctx, issue);
    return true;
  }

  if (subcommand === "create") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const title = parsed.positional.join(" ").trim();
    if (!title) {
      ctx.ui.notify(
        "Usage: /bw create <title> [--type task|epic] [--description text] [--priority n] [--parent id]",
        "info",
      );
      return true;
    }

    const created = await deps.adapter.createIssue(ctx.cwd, {
      title,
      type: readStringOption(parsed.options, "type"),
      description: readStringOption(parsed.options, "description"),
      priority: readNumberOption(parsed.options, "priority"),
      parentId: readStringOption(parsed.options, "parent"),
    });
    await showMutationResult(ctx, "Created", created.issue);
    return true;
  }

  if (subcommand === "update") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const issueId = parsed.positional[0];
    if (!issueId) {
      ctx.ui.notify(
        "Usage: /bw update <issue-id> [--title text] [--description text] [--priority n] [--assignee name] [--status open|in_progress|closed|deferred] [--type task|epic] [--parent id|--clear-parent] [--defer when] [--due when|--clear-due]",
        "info",
      );
      return true;
    }

    const updateInput = buildUpdateInput(parsed.options);
    if (!hasIssueUpdate(updateInput)) {
      ctx.ui.notify("No update fields supplied. Pass at least one --flag to mutate.", "info");
      return true;
    }

    const issue = await deps.adapter.updateIssue(ctx.cwd, issueId, updateInput);
    await showMutationResult(ctx, "Updated", issue);
    return true;
  }

  if (subcommand === "dep") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const operation = parsed.positional[0];
    const pair = normalizeDependencyPair(parsed.positional.slice(1));
    if (!operation || !pair || (operation !== "add" && operation !== "remove")) {
      ctx.ui.notify("Usage: /bw dep <add|remove> <blocker-id> [blocks] <blocked-id>", "info");
      return true;
    }

    if (operation === "add") {
      await deps.adapter.addDependency(ctx.cwd, pair.blockerId, pair.blockedId);
      ctx.ui.notify(`Dependency added: ${pair.blockerId} blocks ${pair.blockedId}.`, "info");
      return true;
    }

    await deps.adapter.removeDependency(ctx.cwd, pair.blockerId, pair.blockedId);
    ctx.ui.notify(
      `Dependency removed: ${pair.blockerId} no longer blocks ${pair.blockedId}.`,
      "info",
    );
    return true;
  }

  if (subcommand === "start") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const issueId = parsed.positional[0];
    if (!issueId) {
      ctx.ui.notify("Usage: /bw start <issue-id> [--assignee name]", "info");
      return true;
    }

    const issue = await deps.adapter.start(
      ctx.cwd,
      issueId,
      readStringOption(parsed.options, "assignee"),
    );
    await showMutationResult(ctx, "Started", issue);
    return true;
  }

  if (subcommand === "close") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const issueId = parsed.positional[0];
    if (!issueId) {
      ctx.ui.notify("Usage: /bw close <issue-id> [--reason text]", "info");
      return true;
    }

    const reasonOption = parsed.options.get("reason");
    const reason = typeof reasonOption === "string" ? reasonOption : undefined;
    const issue = await deps.adapter.close(ctx.cwd, issueId, reason);
    await showMutationResult(ctx, "Closed", issue);
    return true;
  }

  if (subcommand === "reopen") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const issueId = parsed.positional[0];
    if (!issueId) {
      ctx.ui.notify("Usage: /bw reopen <issue-id>", "info");
      return true;
    }

    const issue = await deps.adapter.reopen(ctx.cwd, issueId);
    await showMutationResult(ctx, "Reopened", issue);
    return true;
  }

  if (subcommand === "comment") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const issueId = parsed.positional[0];
    const text = parsed.positional.slice(1).join(" ");
    if (!issueId || !text) {
      ctx.ui.notify("Usage: /bw comment <issue-id> <text> [--author name]", "info");
      return true;
    }

    const issue = await deps.adapter.comment(
      ctx.cwd,
      issueId,
      text,
      readStringOption(parsed.options, "author"),
    );
    await showMutationResult(ctx, "Commented", issue);
    return true;
  }

  if (subcommand === "label") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const issueId = parsed.positional[0];
    const operations = parsed.positional.slice(1);
    if (!issueId || operations.length === 0) {
      ctx.ui.notify("Usage: /bw label <issue-id> +label [-label]...", "info");
      return true;
    }

    const issue = await deps.adapter.label(ctx.cwd, issueId, operations);
    await showMutationResult(ctx, "Labeled", issue);
    return true;
  }

  if (subcommand === "defer") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const issueId = parsed.positional[0];
    const when = parsed.positional.slice(1).join(" ");
    if (!issueId || !when) {
      ctx.ui.notify("Usage: /bw defer <issue-id> <when>", "info");
      return true;
    }

    const issue = await deps.adapter.defer(ctx.cwd, issueId, when);
    await showMutationResult(ctx, "Deferred", issue);
    return true;
  }

  if (subcommand === "undefer") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    const issueId = parsed.positional[0];
    if (!issueId) {
      ctx.ui.notify("Usage: /bw undefer <issue-id>", "info");
      return true;
    }

    const issue = await deps.adapter.undefer(ctx.cwd, issueId);
    await showMutationResult(ctx, "Undeferred", issue);
    return true;
  }

  if (subcommand === "sync") {
    const active = await deps.requireActive(ctx);
    if (!active) {
      return true;
    }

    await deps.adapter.sync(ctx.cwd);
    ctx.ui.notify("bw sync completed.", "info");
    return true;
  }

  return false;
}
