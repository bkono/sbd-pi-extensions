import { Type } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { detectActivation } from "./activation.js";
import { parseArgv } from "./argv.js";
import { createBeadworkAdapter } from "./bw.js";
import {
  showAdoptionPreview,
  showAdoptionResult,
  showIssue,
  showMutationResult,
  showPrime,
  showReady,
  showStatus,
} from "./commands.js";
import { loadConfig } from "./config.js";
import { COMMAND_NAME, DEFAULT_SESSION_STATE } from "./constants.js";
import {
  applyAdoptionPlan,
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
  SessionScope,
  SessionState,
} from "./types.js";

export { loadConfig } from "./config.js";
export type {
  ActivationState,
  AdoptionApplyResult,
  AdoptionDependency,
  AdoptionLandMode,
  AdoptionOptions,
  AdoptionPlan,
  AdoptionStep,
  BeadworkConfig,
  BeadworkCounts,
  BeadworkIssue,
  BeadworkIssueDetail,
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

    try {
      return await saveSessionState(getStateDir(ctx, activation, config), sessionId, normalized);
    } catch {
      return normalized;
    }
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
  }> {
    const config = loadConfig(ctx.cwd);
    const activation = await detectActivation(ctx.cwd);
    const state = await readSessionState(ctx, activation, config);
    const [counts, scopeDetail] = await Promise.all([
      resolveCounts(ctx, activation, state),
      resolveScopeDetail(ctx, activation, state),
    ]);

    updateStatusline(ctx, activation, state, config);

    return { activation, state, counts, scopeDetail };
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

  async function setInteractiveMode(
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    scope?: SessionScope,
  ): Promise<{ state: SessionState; scopeDetail?: BeadworkIssueDetail }> {
    const stateWithPrime = await ensurePrime(ctx, activation, config, state, false);
    const nextState = await writeSessionState(ctx, activation, config, {
      ...stateWithPrime,
      mode: "interactive",
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

  pi.registerCommand(COMMAND_NAME, {
    description: "Beadwork session status, engagement, and ticket helpers",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommand = "status", ...restParts] =
        trimmed.length > 0 ? parseArgv(trimmed).positional : [];
      const remainder = trimmed.length > 0 ? trimmed.slice(subcommand.length).trim() : "";
      const parsed = parseArgv(remainder);

      try {
        if (subcommand === "status") {
          const status = await refreshStatus(ctx);
          await showStatus(ctx, status);
          return;
        }

        if (subcommand === "off") {
          const activation = await detectActivation(ctx.cwd);
          const state = await resetState(ctx);
          ctx.ui.notify("Beadwork session mode reset to neutral.", "info");
          await showStatus(ctx, { activation, state });
          return;
        }

        if (subcommand === "engage") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const scopeArg = parsed.positional[0] ?? restParts[0];
          const scope = scopeArg
            ? ((await resolveScopeFromArg(ctx, scopeArg)) as
                | Exclude<SessionScope, { kind: "none" }>
                | undefined)
            : undefined;
          const { state, scopeDetail } = await setInteractiveMode(
            ctx,
            active.activation,
            active.config,
            active.state,
            scope,
          );
          const counts = await resolveCounts(ctx, active.activation, state);
          ctx.ui.notify(
            scope
              ? `Beadwork interactive mode engaged for ${scope.kind} ${scope.id}.`
              : "Beadwork interactive mode engaged.",
            "info",
          );
          await showStatus(ctx, {
            activation: active.activation,
            state,
            counts,
            scopeDetail,
          });
          return;
        }

        if (subcommand === "prime") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const refresh = parsed.options.has("refresh");
          const state = await ensurePrime(
            ctx,
            active.activation,
            active.config,
            active.state,
            refresh,
          );
          await showPrime(ctx, state.prime?.content ?? "", state.prime?.loadedAt);
          return;
        }

        if (subcommand === "ready") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const scopeId =
            parsed.positional[0] ??
            (active.state.scope.kind === "none" ? undefined : active.state.scope.id);
          const ready = await adapter.ready(ctx.cwd, scopeId);
          await showReady(ctx, ready, scopeId);
          return;
        }

        if (subcommand === "show") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId =
            parsed.positional[0] ??
            (active.state.scope.kind === "none" ? undefined : active.state.scope.id);
          if (!issueId) {
            ctx.ui.notify("Usage: /bw show <issue-id>", "info");
            return;
          }

          const issue = await adapter.show(ctx.cwd, issueId);
          await showIssue(ctx, issue);
          return;
        }

        if (subcommand === "start") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId = parsed.positional[0];
          if (!issueId) {
            ctx.ui.notify("Usage: /bw start <issue-id> [--assignee name]", "info");
            return;
          }

          const assigneeOption = parsed.options.get("assignee");
          const assignee = typeof assigneeOption === "string" ? assigneeOption : undefined;
          const issue = await adapter.start(ctx.cwd, issueId, assignee);
          await showMutationResult(ctx, "Started", issue);
          return;
        }

        if (subcommand === "close") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          const issueId = parsed.positional[0];
          if (!issueId) {
            ctx.ui.notify("Usage: /bw close <issue-id> [--reason text]", "info");
            return;
          }

          const reasonOption = parsed.options.get("reason");
          const reason = typeof reasonOption === "string" ? reasonOption : undefined;
          const issue = await adapter.close(ctx.cwd, issueId, reason);
          await showMutationResult(ctx, "Closed", issue);
          return;
        }

        if (subcommand === "sync") {
          const active = await requireActive(ctx);
          if (!active) {
            return;
          }

          await adapter.sync(ctx.cwd);
          ctx.ui.notify("bw sync completed.", "info");
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
          const apply = parsed.options.has("apply");
          const sequential = !parsed.options.has("no-sequential");
          const editorText = "getEditorText" in ctx.ui ? ctx.ui.getEditorText() : undefined;
          const source = resolvePlanSource(
            parsed.positional.join(" "),
            editorText,
            ctx.sessionManager.getBranch() as Parameters<typeof resolvePlanSource>[2],
          );

          if (!source) {
            ctx.ui.notify(
              "No plan text found. Pass plan text to /bw adopt, keep it in the editor, or run after producing a plan in the session.",
              "warning",
            );
            return;
          }

          const plan = buildAdoptionPlan(source, { title, landMode, sequential });
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
            await setInteractiveMode(
              ctx,
              active.activation,
              active.config,
              active.state,
              rootScope,
            );
            resultLines.push(`Session scope set to ${rootScope.kind}:${rootScope.id}`);
          }
          await showAdoptionResult(ctx, resultLines);
          return;
        }

        if (subcommand === "run") {
          ctx.ui.notify(
            "/bw run is not implemented yet. Use /bw engage plus ticket tools for now.",
            "info",
          );
          return;
        }

        ctx.ui.notify(
          "Usage: /bw [status|engage [scope]|prime [--refresh]|ready [scope]|show <id>|start <id>|close <id>|sync|adopt [--title ...] [--land quick|branch|multi] [--apply]|off]",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(humanizeError(error), "error");
      }
    },
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
    description: "Return the cached or freshly loaded `bw prime` guidance.",
    parameters: Type.Object({
      refresh: Type.Optional(Type.Boolean({ description: "Force a fresh `bw prime` read." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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

      state = await ensurePrime(ctx, activation, config, state, params.refresh === true);
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
}
