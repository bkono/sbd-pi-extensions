import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { handleCleanupAction } from "./actions/cleanup.js";
import {
  handleAbandonAction,
  maybeExitGoalOnClosedIssue,
  maybeExitGoalOnClosedScopeDetail,
} from "./actions/goal-exit.js";
import { handleIssuesAction } from "./actions/issues.js";
import { handleRunAction, parentIsBusy, startGoal, toGoalStartToolResult } from "./actions/run.js";
import { handleScopeAction } from "./actions/scope.js";
import { handleStatusAction } from "./actions/status.js";
import { detectActivation } from "./activation.js";
import { parseArgv } from "./argv.js";
import { createBeadworkAdapter } from "./bw.js";
import { registerBeadworkCommandAliases } from "./command-aliases.js";
import { createBeadworkCommandCompletionFactory } from "./command-completions.js";
import { showAdoptionPreview, showAdoptionResult, showStatus } from "./commands.js";
import { loadConfig } from "./config.js";
import { COMMAND_NAME, DEFAULT_SESSION_STATE } from "./constants.js";
import {
  applyAdoptionPlan,
  buildAdoptionDecompositionPrompt,
  buildAdoptionPlan,
  formatAdoptionPreview,
  parseLandMode,
  resolvePlanSource,
} from "./plan-adoption.js";
import { buildBeadworkPromptAppendix } from "./prompt.js";
import {
  loadSessionState,
  resetSessionState,
  resolveSessionStateDir,
  saveSessionState,
} from "./session-state.js";
import { updateStatusline } from "./statusline.js";
import type {
  ActivationState,
  BeadworkConfig,
  BeadworkCounts,
  BeadworkIssueDetail,
  BeadworkListFilters,
  BeadworkUpdateIssueInput,
  SessionScope,
  SessionState,
} from "./types.js";

export { loadConfig } from "./config.js";
export type {
  ActivationState,
  AdoptionApplyResult,
  AdoptionDependency,
  AdoptionInputStep,
  AdoptionLandMode,
  AdoptionOptions,
  AdoptionPlan,
  AdoptionStep,
  BeadworkConfig,
  BeadworkCounts,
  BeadworkHistoryEntry,
  BeadworkIssue,
  BeadworkIssueDetail,
  BeadworkListFilters,
  BeadworkUpdateIssueInput,
  SessionMode,
  SessionScope,
  SessionState,
} from "./types.js";

function buildDefaultSessionState(): SessionState {
  return {
    ...DEFAULT_SESSION_STATE,
    updatedAt: new Date().toISOString(),
  };
}

function stalePrimeForRepo(state: SessionState, repoRoot: string | undefined): boolean {
  return Boolean(state.prime?.repoRoot && repoRoot && state.prime.repoRoot !== repoRoot);
}

function humanizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

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

function _buildListFilters(options: Map<string, string | true>): BeadworkListFilters {
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

function _buildUpdateInput(options: Map<string, string | true>): BeadworkUpdateIssueInput {
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

function _normalizeDependencyPair(args: string[]): { blockerId: string; blockedId: string } | null {
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

export default function piBeadworkExtension(pi: ExtensionAPI): void {
  const adapter = createBeadworkAdapter();
  const stateCache = new Map<string, SessionState>();

  function getStateDir(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
  ): string {
    return resolveSessionStateDir(activation.repoRoot ?? ctx.cwd, config.storage.sessionStateDir);
  }

  async function readSessionState(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
  ): Promise<SessionState> {
    const sessionId = ctx.sessionManager.getSessionId();
    const cached = stateCache.get(sessionId);
    if (cached) {
      if (stalePrimeForRepo(cached, activation.repoRoot)) {
        const nextState = {
          ...cached,
          prime: undefined,
          updatedAt: new Date().toISOString(),
        };
        stateCache.set(sessionId, nextState);
        return nextState;
      }
      return cached;
    }

    try {
      const state = await loadSessionState(getStateDir(ctx, activation, config), sessionId);
      const normalized = stalePrimeForRepo(state, activation.repoRoot)
        ? { ...state, prime: undefined, updatedAt: new Date().toISOString() }
        : state;
      stateCache.set(sessionId, normalized);
      return normalized;
    } catch {
      const fallback = buildDefaultSessionState();
      stateCache.set(sessionId, fallback);
      return fallback;
    }
  }

  async function writeSessionState(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
  ): Promise<SessionState> {
    const sessionId = ctx.sessionManager.getSessionId();
    const normalized = {
      ...state,
      updatedAt: new Date().toISOString(),
    };

    stateCache.set(sessionId, normalized);

    let persisted = normalized;
    try {
      persisted = await saveSessionState(
        getStateDir(ctx, activation, config),
        sessionId,
        normalized,
      );
    } catch {
      persisted = normalized;
    }

    return persisted;
  }

  async function resolveScopeDetail(
    ctx: ExtensionContext,
    activation: ActivationState,
    state: SessionState,
  ): Promise<BeadworkIssueDetail | undefined> {
    if (activation.kind !== "active" || state.scope.kind === "none") {
      return undefined;
    }

    try {
      return await adapter.show(ctx.cwd, state.scope.id);
    } catch {
      return undefined;
    }
  }

  async function resolveCounts(
    ctx: ExtensionContext,
    activation: ActivationState,
    state: SessionState,
  ): Promise<BeadworkCounts | undefined> {
    if (activation.kind !== "active") {
      return undefined;
    }

    try {
      const scopeId = state.scope.kind === "none" ? undefined : state.scope.id;
      return await adapter.getCounts(ctx.cwd, scopeId);
    } catch {
      return undefined;
    }
  }

  async function ensurePrime(
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    force = false,
  ): Promise<SessionState> {
    if (activation.kind !== "active") {
      return state;
    }

    if (!force && state.prime?.content && state.prime.repoRoot === activation.repoRoot) {
      return state;
    }

    const prime = await adapter.prime(ctx.cwd);
    return writeSessionState(ctx, activation, config, {
      ...state,
      prime: {
        content: prime,
        loadedAt: new Date().toISOString(),
        repoRoot: activation.repoRoot,
      },
    });
  }

  async function refreshStatus(ctx: ExtensionContext): Promise<{
    activation: ActivationState;
    state: SessionState;
    counts?: BeadworkCounts;
    scopeDetail?: BeadworkIssueDetail;
    config?: BeadworkConfig;
  }> {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    let state = await readSessionState(ctx, activation, config);

    const [counts, scopeDetail] = await Promise.all([
      resolveCounts(ctx, activation, state),
      resolveScopeDetail(ctx, activation, state),
    ]);

    state = await maybeExitGoalOnClosedScopeDetail({
      ctx,
      activation,
      config,
      state,
      scopeDetail,
      deps: { pi, writeSessionState },
      parentBusy: parentIsBusy(ctx),
    });

    updateStatusline(ctx, activation, state, config);

    return { activation, state, counts, scopeDetail, config };
  }

  async function resetState(ctx: ExtensionCommandContext): Promise<SessionState> {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    const nextState = buildDefaultSessionState();

    stateCache.set(sessionId, nextState);

    try {
      const persisted = await resetSessionState(getStateDir(ctx, activation, config), sessionId);
      stateCache.set(sessionId, persisted);
      updateStatusline(ctx, activation, persisted, config);
      return persisted;
    } catch {
      updateStatusline(ctx, activation, nextState, config);
      return nextState;
    }
  }

  async function requireActive(ctx: ExtensionCommandContext): Promise<{
    activation: ActivationState;
    config: BeadworkConfig;
    state: SessionState;
  } | null> {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    const state = await readSessionState(ctx, activation, config);

    if (activation.kind !== "active") {
      await showStatus(ctx, { activation, state });
      ctx.ui.notify("Beadwork is not active in this repository.", "warning");
      return null;
    }

    return { activation, config, state };
  }

  async function setSessionMode(
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    mode: SessionState["mode"],
    scope?: SessionScope,
  ): Promise<{ state: SessionState; scopeDetail?: BeadworkIssueDetail }> {
    const stateWithPrime = await ensurePrime(ctx, activation, config, state, false);
    const nextState = await writeSessionState(ctx, activation, config, {
      ...stateWithPrime,
      mode,
      engagedAt: new Date().toISOString(),
      scope: scope ?? state.scope,
    });
    const scopeDetail = await resolveScopeDetail(ctx, activation, nextState);
    updateStatusline(ctx, activation, nextState, config);
    return { state: nextState, scopeDetail };
  }

  async function resolveScopeFromArg(
    ctx: ExtensionCommandContext,
    scopeId: string | undefined,
  ): Promise<SessionScope | undefined> {
    if (!scopeId) {
      return undefined;
    }

    const issue = await adapter.show(ctx.cwd, scopeId);
    return {
      kind: issue.type === "epic" ? "epic" : "ticket",
      id: issue.id,
      title: issue.title,
    };
  }

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    const state = await readSessionState(ctx, activation, config);
    await writeSessionState(ctx, activation, config, state);
    updateStatusline(ctx, activation, state, config);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    let state = await readSessionState(ctx, activation, config);

    if (activation.kind !== "active" || state.mode === "neutral") {
      return undefined;
    }

    try {
      state = await ensurePrime(ctx, activation, config, state, false);
    } catch {
      // ignore prompt enrichment failures; interactive mode still works without cached prime
    }

    const scopeDetail = await resolveScopeDetail(ctx, activation, state);
    state = await maybeExitGoalOnClosedScopeDetail({
      ctx,
      activation,
      config,
      state,
      scopeDetail,
      deps: { pi, writeSessionState },
      parentBusy: parentIsBusy(ctx),
    });
    if (state.mode === "neutral") {
      return undefined;
    }
    const appendix = buildBeadworkPromptAppendix({
      activation,
      sessionState: state,
      scopeDetail,
    });

    if (!appendix) {
      return undefined;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${appendix}`,
    };
  });

  const commandCompletions = createBeadworkCommandCompletionFactory({
    adapter,
    detectActivation,
    getCwd: () => process.cwd(),
  });

  async function dispatchBeadworkCommand(
    subcommand: string,
    args: string,
    ctx: ExtensionCommandContext,
    options: { isBare?: boolean } = {},
  ): Promise<void> {
    const parsed = parseArgv(args);

    try {
      if (
        await handleStatusAction({
          subcommand,
          parsed,
          isBare: options.isBare === true,
          ctx,
          deps: {
            pi,
            adapter,
            refreshStatus,
            requireActive,
            ensurePrime,
            setSessionMode,
            writeSessionState,
            resolveCounts,
          },
        })
      ) {
        return;
      }

      if (
        await handleScopeAction({
          subcommand,
          parsed,
          ctx,
          deps: {
            requireActive,
            resolveScopeFromArg,
            setSessionMode,
            resolveCounts,
          },
        })
      ) {
        return;
      }

      if (
        await handleIssuesAction({
          subcommand,
          parsed,
          ctx,
          deps: {
            adapter,
            requireActive,
            onClosedIssue: async (commandCtx, closed) => {
              await maybeExitGoalOnClosedIssue({
                ctx: commandCtx,
                activation: closed.activation,
                config: closed.config,
                state: closed.state,
                issue: closed.issue,
                deps: { pi, writeSessionState },
                command: "close",
                parentBusy: parentIsBusy(commandCtx),
              });
            },
          },
        })
      ) {
        return;
      }

      if (
        await handleCleanupAction({
          subcommand,
          parsed,
          ctx,
          deps: {
            loadConfig,
            detectActivation,
            readState: readSessionState,
            resetState,
            pi,
            parentIsBusy,
          },
        })
      ) {
        return;
      }

      if (
        await handleRunAction({
          subcommand,
          parsed,
          ctx,
          deps: {
            pi,
            adapter,
            requireActive,
            ensurePrime,
            setSessionMode,
            writeSessionState,
          },
        })
      ) {
        return;
      }

      if (
        await handleAbandonAction({
          subcommand,
          ctx,
          deps: {
            pi,
            requireActive,
            writeSessionState,
          },
        })
      ) {
        return;
      }

      if (subcommand === "adopt") {
        const landMode = parseLandMode(
          typeof parsed.options.get("land") === "string"
            ? String(parsed.options.get("land"))
            : undefined,
        );
        const title =
          typeof parsed.options.get("title") === "string"
            ? String(parsed.options.get("title"))
            : undefined;
        const planFile =
          typeof parsed.options.get("file") === "string"
            ? path.resolve(ctx.cwd, String(parsed.options.get("file")))
            : undefined;
        const apply = parsed.options.has("apply");
        const editorText = "getEditorText" in ctx.ui ? ctx.ui.getEditorText() : undefined;

        let fileText: string | undefined;
        if (planFile) {
          try {
            fileText = await readFile(planFile, "utf8");
          } catch (error) {
            throw new Error(`Failed to read plan file ${planFile}: ${humanizeError(error)}`);
          }
        }

        const source = resolvePlanSource({
          inlineText: parsed.positional.join(" "),
          editorText,
          file: planFile ? { path: planFile, markdown: fileText } : undefined,
        });

        if (!source) {
          ctx.ui.notify(
            planFile
              ? `No markdown content found in ${planFile}.`
              : "No explicit markdown plan source found. Pass markdown to /bw adopt, provide --file <path>, or keep the plan in the editor.",
            "warning",
          );
          return;
        }

        const plan = buildAdoptionPlan(source, { title, landMode });
        const preview = formatAdoptionPreview(plan);

        if (!apply) {
          await showAdoptionPreview(ctx, plan, preview);
          return;
        }

        if (plan.landMode === "quick") {
          await showAdoptionResult(ctx, [preview, "", "No beadwork mutation performed."]);
          return;
        }

        const active = await requireActive(ctx);
        if (!active) {
          return;
        }

        if (plan.landMode === "multi") {
          const decompositionPrompt = buildAdoptionDecompositionPrompt(plan);
          pi.sendUserMessage(decompositionPrompt);
          await showAdoptionResult(ctx, [
            preview,
            "",
            "Queued an LLM-guided decomposition turn.",
            "The model will materialize the graph via beadwork_create_issue and beadwork_add_dependency.",
            "Review the resulting epic/task graph, then run /bw status or /bw show <epic-id>.",
          ]);
          return;
        }

        const result = await applyAdoptionPlan(adapter, ctx.cwd, plan);
        const resultLines = [preview, "", "Created:"];
        for (const issue of result.created) {
          resultLines.push(`- ${issue.id} · ${issue.type} · ${issue.title}`);
        }
        if (result.root) {
          resultLines.push("", `Root issue: ${result.root.id}`);
          const rootScope: Exclude<SessionScope, { kind: "none" }> = {
            kind: result.root.type === "epic" ? "epic" : "ticket",
            id: result.root.id,
            title: result.root.title,
          };
          await setSessionMode(
            ctx,
            active.activation,
            active.config,
            active.state,
            "interactive",
            rootScope,
          );
          resultLines.push(`Session scope set to ${rootScope.kind}:${rootScope.id}`);
        }

        await showAdoptionResult(ctx, resultLines);
        return;
      }

      ctx.ui.notify(
        "Usage: /bw [status|engage [scope]|scope <issue-id|clear>|prime|ready [scope]|blocked|list [--all --status ... --type ... --parent ... --priority n --assignee ... --grep ... --limit n --deferred --overdue]|history <id> [--limit n]|show <id>|create <title> [--type ... --description ... --priority n --parent id]|update <id> [--title ... --description ... --priority n --assignee ... --status ... --type ... --parent id|--clear-parent --defer when --due when|--clear-due]|dep <add|remove> <blocker> [blocks] <blocked>|start <id>|close <id>|reopen <id>|comment <id> <text>|label <id> +label [-label]|defer <id> <when>|undefer <id>|sync|run <epic-id>|abandon|adopt [markdown-plan] [--file path/to/plan.md] [--title ...] [--land quick|branch|multi] [--apply]|off]",
        "info",
      );
    } catch (error) {
      ctx.ui.notify(humanizeError(error), "error");
    }
  }

  pi.registerCommand(COMMAND_NAME, {
    description: "Open the beadwork dashboard or run beadwork session commands",
    getArgumentCompletions: (prefix) => commandCompletions.getMainCommandCompletions(prefix),
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        await dispatchBeadworkCommand("status", "", ctx, { isBare: true });
        return;
      }

      const firstSpace = trimmed.search(/\s/);
      const subcommand = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
      const remainder = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
      await dispatchBeadworkCommand(subcommand, remainder, ctx);
    },
  });

  registerBeadworkCommandAliases({
    pi,
    dispatch: (subcommand, args, ctx) => dispatchBeadworkCommand(subcommand, args, ctx),
    getAliasCompletions: (subcommand, prefix) =>
      commandCompletions.getAliasCommandCompletions(subcommand, prefix),
  });

  pi.registerTool({
    name: "beadwork_status",
    label: "Beadwork Status",
    description: "Show beadwork activation, mode, counts, and scope context.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const status = await refreshStatus(ctx);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        details: status,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_prime",
    label: "Beadwork Prime",
    description: "Run `bw prime` and return its current guidance.",
    parameters: Type.Object({
      refresh: Type.Optional(
        Type.Boolean({
          description: "Deprecated compatibility flag; explicit reads are always fresh.",
        }),
      ),
    }),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const activation = await detectActivation(ctx.cwd);
      let state = await readSessionState(ctx, activation, config);

      if (activation.kind !== "active") {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ activation, state }, null, 2) },
          ],
          details: { activation, state },
        };
      }

      state = await ensurePrime(ctx, activation, config, state, true);
      return {
        content: [{ type: "text" as const, text: state.prime?.content ?? "" }],
        details: state.prime,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_ready",
    label: "Beadwork Ready",
    description: "List ready beadwork issues, optionally scoped to an issue subtree.",
    parameters: Type.Object({
      scope_id: Type.Optional(
        Type.String({ description: "Optional issue id to scope `bw ready` to a subtree." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ready = await adapter.ready(ctx.cwd, params.scope_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(ready, null, 2) }],
        details: ready,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_blocked",
    label: "Beadwork Blocked",
    description: "List currently blocked beadwork issues.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const blocked = await adapter.blocked(ctx.cwd);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(blocked, null, 2) }],
        details: blocked,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_list_issues",
    label: "Beadwork List Issues",
    description: "List beadwork issues with explicit filters.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by status." })),
      type: Type.Optional(Type.String({ description: "Filter by type." })),
      parent_id: Type.Optional(Type.String({ description: "Filter by parent issue id." })),
      priority: Type.Optional(Type.Number({ description: "Filter by priority number." })),
      assignee: Type.Optional(Type.String({ description: "Filter by assignee." })),
      grep: Type.Optional(Type.String({ description: "Search title/description text." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of issues." })),
      all: Type.Optional(Type.Boolean({ description: "Include all statuses." })),
      deferred: Type.Optional(Type.Boolean({ description: "Only deferred issues." })),
      overdue: Type.Optional(Type.Boolean({ description: "Only overdue issues." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issues = await adapter.list(ctx.cwd, {
        status: params.status,
        type: params.type,
        parent: params.parent_id,
        priority: params.priority,
        assignee: params.assignee,
        grep: params.grep,
        limit: params.limit,
        all: params.all,
        deferred: params.deferred,
        overdue: params.overdue,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issues, null, 2) }],
        details: issues,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_issue_history",
    label: "Beadwork Issue History",
    description: "Read beadwork git history entries for one issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to inspect." }),
      limit: Type.Optional(Type.Number({ description: "Maximum history entries." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const history = await adapter.history(ctx.cwd, params.id, params.limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(history, null, 2) }],
        details: history,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_show",
    label: "Beadwork Show",
    description: "Show one beadwork issue including children.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to inspect." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.show(ctx.cwd, params.id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_create_issue",
    label: "Beadwork Create Issue",
    description: "Create a beadwork issue or epic.",
    parameters: Type.Object({
      title: Type.String({ description: "Issue title." }),
      description: Type.Optional(Type.String({ description: "Issue description." })),
      type: Type.Optional(Type.String({ description: "Issue type, e.g. task or epic." })),
      priority: Type.Optional(Type.Number({ description: "Priority number 0-4." })),
      parent_id: Type.Optional(Type.String({ description: "Optional parent epic id." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const created = await adapter.createIssue(ctx.cwd, {
        title: params.title,
        description: params.description,
        type: params.type,
        priority: params.priority,
        parentId: params.parent_id,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(created.issue, null, 2) }],
        details: created.issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_update_issue",
    label: "Beadwork Update Issue",
    description: "Update mutable fields on an existing beadwork issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to update." }),
      title: Type.Optional(Type.String({ description: "New title." })),
      description: Type.Optional(Type.String({ description: "New description." })),
      priority: Type.Optional(Type.Number({ description: "Priority number 0-4." })),
      assignee: Type.Optional(Type.String({ description: "New assignee." })),
      type: Type.Optional(Type.String({ description: "New issue type." })),
      status: Type.Optional(Type.String({ description: "New status." })),
      parent_id: Type.Optional(Type.String({ description: "New parent issue id." })),
      clear_parent: Type.Optional(Type.Boolean({ description: "Clear parent relationship." })),
      defer_until: Type.Optional(Type.String({ description: "Set defer date expression." })),
      due_at: Type.Optional(Type.String({ description: "Set due date expression." })),
      clear_due: Type.Optional(Type.Boolean({ description: "Clear due date." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const updateInput: BeadworkUpdateIssueInput = {
        title: params.title,
        description: params.description,
        priority: params.priority,
        assignee: params.assignee,
        type: params.type,
        status: params.status,
        parentId: params.clear_parent ? null : params.parent_id,
        deferUntil: params.defer_until,
        dueAt: params.clear_due ? null : params.due_at,
      };

      if (!hasIssueUpdate(updateInput)) {
        throw new Error("No update fields provided.");
      }

      const issue = await adapter.updateIssue(ctx.cwd, params.id, updateInput);
      if (issue.status === "closed") {
        const config = loadConfig(ctx.cwd);
        const activation = await detectActivation(ctx.cwd);
        const state = await readSessionState(ctx, activation, config);
        await maybeExitGoalOnClosedIssue({
          ctx,
          activation,
          config,
          state,
          issue,
          deps: { pi, writeSessionState },
          command: "beadwork_update_issue",
          parentBusy: true,
        });
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_add_dependency",
    label: "Beadwork Add Dependency",
    description: "Add a beadwork dependency edge: blocker blocks blocked.",
    parameters: Type.Object({
      blocker_id: Type.String({ description: "Blocking issue id." }),
      blocked_id: Type.String({ description: "Blocked issue id." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await adapter.addDependency(ctx.cwd, params.blocker_id, params.blocked_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                blocker_id: params.blocker_id,
                blocked_id: params.blocked_id,
                ok: true,
              },
              null,
              2,
            ),
          },
        ],
        details: { blockerId: params.blocker_id, blockedId: params.blocked_id },
      };
    },
  });

  pi.registerTool({
    name: "beadwork_remove_dependency",
    label: "Beadwork Remove Dependency",
    description: "Remove a beadwork dependency edge: blocker blocks blocked.",
    parameters: Type.Object({
      blocker_id: Type.String({ description: "Blocking issue id." }),
      blocked_id: Type.String({ description: "Blocked issue id." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await adapter.removeDependency(ctx.cwd, params.blocker_id, params.blocked_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                blocker_id: params.blocker_id,
                blocked_id: params.blocked_id,
                ok: true,
              },
              null,
              2,
            ),
          },
        ],
        details: { blockerId: params.blocker_id, blockedId: params.blocked_id },
      };
    },
  });

  pi.registerTool({
    name: "beadwork_start_issue",
    label: "Beadwork Start Issue",
    description: "Run `bw start` for one issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to start." }),
      assignee: Type.Optional(Type.String({ description: "Optional assignee override." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.start(ctx.cwd, params.id, params.assignee);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_close_issue",
    label: "Beadwork Close Issue",
    description: "Run `bw close` for one issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to close." }),
      reason: Type.Optional(Type.String({ description: "Optional close reason." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.close(ctx.cwd, params.id, params.reason);
      const config = loadConfig(ctx.cwd);
      const activation = await detectActivation(ctx.cwd);
      const state = await readSessionState(ctx, activation, config);
      await maybeExitGoalOnClosedIssue({
        ctx,
        activation,
        config,
        state,
        issue,
        deps: { pi, writeSessionState },
        command: "beadwork_close_issue",
        parentBusy: true,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_reopen_issue",
    label: "Beadwork Reopen Issue",
    description: "Reopen a beadwork issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to reopen." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.reopen(ctx.cwd, params.id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_comment_issue",
    label: "Beadwork Comment Issue",
    description: "Add a comment to a beadwork issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to comment on." }),
      text: Type.String({ description: "Comment text." }),
      author: Type.Optional(Type.String({ description: "Optional comment author." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.comment(ctx.cwd, params.id, params.text, params.author);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_label_issue",
    label: "Beadwork Label Issue",
    description: "Apply label add/remove operations to a beadwork issue.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to label." }),
      operations: Type.String({
        description: "Comma-separated label operations, e.g. +bug,-triage",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const operations = params.operations
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (operations.length === 0) {
        throw new Error("At least one label operation is required.");
      }

      const issue = await adapter.label(ctx.cwd, params.id, operations);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_defer_issue",
    label: "Beadwork Defer Issue",
    description: "Defer a beadwork issue until a date expression.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to defer." }),
      when: Type.String({ description: "Date expression, e.g. tomorrow or 2026-04-20." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.defer(ctx.cwd, params.id, params.when);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_undefer_issue",
    label: "Beadwork Undefer Issue",
    description: "Restore a deferred beadwork issue back to open.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id to undefer." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const issue = await adapter.undefer(ctx.cwd, params.id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }],
        details: issue,
      };
    },
  });

  pi.registerTool({
    name: "beadwork_sync",
    label: "Beadwork Sync",
    description: "Run `bw sync` in the current repository.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      await adapter.sync(ctx.cwd);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true }, null, 2) }],
        details: { ok: true },
      };
    },
  });

  pi.registerTool({
    name: "beadwork_start_goal",
    label: "Beadwork Start Goal",
    description:
      "Start Beadwork's manager-only goal mode for an existing open epic and queue the parent continuation that refreshes ready work and orchestrates it. Call this only after deliberately choosing to execute an already-decomposed epic. It does not implement the epic synchronously, dispatch children, or discover an epic for you.",
    parameters: Type.Object({
      epic_id: Type.String({
        description:
          "Open epic id to enter manager-only goal mode for. Required; never inferred from conversation, ready work, or current scope.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const activation = await detectActivation(ctx.cwd);
      const state = await readSessionState(ctx, activation, config);
      const result = await startGoal({
        ctx: ctx as ExtensionCommandContext,
        deps: {
          pi,
          adapter,
          requireActive,
          ensurePrime,
          setSessionMode,
          writeSessionState,
        },
        epicId: params.epic_id,
        session: { activation, state },
      });
      const details = toGoalStartToolResult(result);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
}
