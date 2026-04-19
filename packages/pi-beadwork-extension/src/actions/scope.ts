import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ParsedArgv } from "../argv.js";
import { showStatus } from "../commands.js";
import type {
  ActivationState,
  BeadworkConfig,
  BeadworkCounts,
  BeadworkIssueDetail,
  SessionScope,
  SessionState,
} from "../types.js";

export type ScopeActionDeps = {
  requireActive: (ctx: ExtensionCommandContext) => Promise<{
    activation: ActivationState;
    config: BeadworkConfig;
    state: SessionState;
  } | null>;
  resolveScopeFromArg: (
    ctx: ExtensionCommandContext,
    scopeId: string | undefined,
  ) => Promise<SessionScope | undefined>;
  setSessionMode: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    mode: SessionState["mode"],
    scope?: SessionScope,
  ) => Promise<{ state: SessionState; scopeDetail?: BeadworkIssueDetail }>;
  resolveCounts: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    state: SessionState,
  ) => Promise<BeadworkCounts | undefined>;
};

export type ScopeMutationResult = {
  state: SessionState;
  counts?: BeadworkCounts;
  scopeDetail?: BeadworkIssueDetail;
};

function isClearScopeToken(value: string | undefined): boolean {
  return value === "clear" || value === "none" || value === "repo" || value === "repo-wide";
}

export async function setInteractiveScope(input: {
  ctx: ExtensionCommandContext;
  activation: ActivationState;
  config: BeadworkConfig;
  state: SessionState;
  deps: Pick<ScopeActionDeps, "setSessionMode" | "resolveCounts">;
  scope?: SessionScope;
}): Promise<ScopeMutationResult> {
  const { state, scopeDetail } = await input.deps.setSessionMode(
    input.ctx,
    input.activation,
    input.config,
    input.state,
    "interactive",
    input.scope,
  );
  const counts = await input.deps.resolveCounts(input.ctx, input.activation, state);
  return { state, counts, scopeDetail };
}

export async function clearInteractiveScope(input: {
  ctx: ExtensionCommandContext;
  activation: ActivationState;
  config: BeadworkConfig;
  state: SessionState;
  deps: Pick<ScopeActionDeps, "setSessionMode" | "resolveCounts">;
}): Promise<ScopeMutationResult> {
  return setInteractiveScope({
    ...input,
    scope: { kind: "none" },
  });
}

export async function handleScopeAction(input: {
  subcommand: string;
  parsed: ParsedArgv;
  ctx: ExtensionCommandContext;
  deps: ScopeActionDeps;
}): Promise<boolean> {
  const { subcommand, parsed, ctx, deps } = input;
  if (subcommand !== "engage" && subcommand !== "scope") {
    return false;
  }

  const active = await deps.requireActive(ctx);
  if (!active) {
    return true;
  }

  const scopeArg = parsed.positional[0];
  if (subcommand === "scope" && isClearScopeToken(scopeArg)) {
    const { state, counts, scopeDetail } = await clearInteractiveScope({
      ctx,
      activation: active.activation,
      config: active.config,
      state: active.state,
      deps,
    });
    ctx.ui.notify("Beadwork scope cleared; interactive mode remains engaged.", "info");
    await showStatus(ctx, {
      activation: active.activation,
      state,
      counts,
      scopeDetail,
    });
    return true;
  }

  const scope = scopeArg
    ? ((await deps.resolveScopeFromArg(ctx, scopeArg)) as
        | Exclude<SessionScope, { kind: "none" }>
        | undefined)
    : undefined;

  const { state, counts, scopeDetail } = await setInteractiveScope({
    ctx,
    activation: active.activation,
    config: active.config,
    state: active.state,
    deps,
    scope,
  });

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
  return true;
}
