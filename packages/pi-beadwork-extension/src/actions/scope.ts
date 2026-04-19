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

function isClearScopeToken(value: string | undefined): boolean {
  return value === "clear" || value === "none" || value === "repo" || value === "repo-wide";
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
    const { state, scopeDetail } = await deps.setSessionMode(
      ctx,
      active.activation,
      active.config,
      active.state,
      "interactive",
      { kind: "none" },
    );
    const counts = await deps.resolveCounts(ctx, active.activation, state);
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

  const { state, scopeDetail } = await deps.setSessionMode(
    ctx,
    active.activation,
    active.config,
    active.state,
    "interactive",
    scope,
  );
  const counts = await deps.resolveCounts(ctx, active.activation, state);
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
