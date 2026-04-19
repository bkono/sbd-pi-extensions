import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ParsedArgv } from "../argv.js";
import type { BeadworkAdapter } from "../bw.js";
import { showRunSummary } from "../commands.js";
import { buildRunOptions, runBoundedEpicLoop } from "../orchestrator.js";
import { updateStatusline } from "../statusline.js";
import type {
  ActivationState,
  BeadworkConfig,
  BeadworkIssueDetail,
  SessionRunOptions,
  SessionScope,
  SessionState,
} from "../types.js";

export type RunActionDeps = {
  adapter: BeadworkAdapter;
  requireActive: (ctx: ExtensionCommandContext) => Promise<{
    activation: ActivationState;
    config: BeadworkConfig;
    state: SessionState;
  } | null>;
  ensurePrime: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    force?: boolean,
  ) => Promise<SessionState>;
  setSessionMode: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
    mode: SessionState["mode"],
    scope?: SessionScope,
    runOptions?: SessionState["runOptions"],
  ) => Promise<{ state: SessionState; scopeDetail?: BeadworkIssueDetail }>;
  writeSessionState: (
    ctx: ExtensionCommandContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
  ) => Promise<SessionState>;
};

export async function executeRunAction(input: {
  ctx: ExtensionCommandContext;
  deps: RunActionDeps;
  epicId: string;
  workers?: number;
  until?: string;
  dryRun?: boolean;
  maxCycles?: number;
  noSpawn?: boolean;
}): Promise<void> {
  const { ctx, deps } = input;
  const active = await deps.requireActive(ctx);
  if (!active) {
    return;
  }

  const epic = await deps.adapter.show(ctx.cwd, input.epicId);
  if (epic.type !== "epic") {
    ctx.ui.notify(`/bw run requires an epic id. ${input.epicId} is a ${epic.type}.`, "warning");
    return;
  }

  const stateWithPrime = await deps.ensurePrime(
    ctx,
    active.activation,
    active.config,
    active.state,
    false,
  );
  const options = buildRunOptions(active.config, {
    workers: input.workers,
    until: input.until,
    dryRun: input.dryRun === true,
    maxCycles: input.maxCycles,
    noSpawn: input.noSpawn === true,
  });
  const sessionRunOptions: SessionRunOptions = {
    workers: options.workers,
    until: options.until,
    noSpawn: options.noSpawn,
    dryRun: options.dryRun,
    maxCycles: options.maxCycles,
  };
  const scope: Exclude<SessionScope, { kind: "none" }> = {
    kind: "epic",
    id: epic.id,
    title: epic.title,
  };

  const { state: preparedState } = options.dryRun
    ? await deps.setSessionMode(
        ctx,
        active.activation,
        active.config,
        stateWithPrime,
        "interactive",
        scope,
      )
    : await deps.setSessionMode(
        ctx,
        active.activation,
        active.config,
        stateWithPrime,
        "run",
        scope,
        sessionRunOptions,
      );

  const persistedPreparedState = await deps.writeSessionState(
    ctx,
    active.activation,
    active.config,
    {
      ...preparedState,
      scope,
      runOptions: options.dryRun ? undefined : sessionRunOptions,
      lastRunOptions: sessionRunOptions,
    },
  );

  const summary = await runBoundedEpicLoop({
    cwd: ctx.cwd,
    repoRoot: active.activation.repoRoot ?? ctx.cwd,
    config: active.config,
    adapter: deps.adapter,
    epicId: epic.id,
    options,
    prime: persistedPreparedState.prime?.content,
  });

  const finalState = await deps.writeSessionState(ctx, active.activation, active.config, {
    ...persistedPreparedState,
    mode: options.dryRun || summary.stopReason !== "max-cycles" ? "interactive" : "run",
    scope,
    runOptions:
      options.dryRun || summary.stopReason !== "max-cycles" ? undefined : sessionRunOptions,
    lastRunOptions: sessionRunOptions,
    recentRunSummary: summary,
  });

  await showRunSummary(ctx, summary);
  if (!options.dryRun && summary.stopReason === "max-cycles") {
    ctx.ui.notify(
      `Background supervision remains armed for ${epic.id}; it will keep polling every ${Math.round(active.config.supervisor.pollIntervalMs / 1000)}s while work is still active.`,
      "info",
    );
  }
  updateStatusline(ctx, active.activation, finalState, active.config, summary.workerSummary);
}

export async function handleRunAction(input: {
  subcommand: string;
  parsed: ParsedArgv;
  ctx: ExtensionCommandContext;
  deps: RunActionDeps;
}): Promise<boolean> {
  const { subcommand, parsed, ctx, deps } = input;
  if (subcommand !== "run") {
    return false;
  }

  const active = await deps.requireActive(ctx);
  if (!active) {
    return true;
  }

  const epicId =
    parsed.positional[0] ??
    (active.state.scope.kind === "epic" ? active.state.scope.id : undefined);
  if (!epicId) {
    ctx.ui.notify(
      "Usage: /bw run <epic-id> [--workers n] [--until blocked|empty] [--max-cycles n] [--dry-run] [--no-spawn]",
      "info",
    );
    return true;
  }

  await executeRunAction({
    ctx,
    deps,
    epicId,
    workers:
      typeof parsed.options.get("workers") === "string"
        ? Number.parseInt(String(parsed.options.get("workers")), 10)
        : undefined,
    until:
      typeof parsed.options.get("until") === "string"
        ? String(parsed.options.get("until"))
        : undefined,
    dryRun: parsed.options.has("dry-run"),
    maxCycles:
      typeof parsed.options.get("max-cycles") === "string"
        ? Number.parseInt(String(parsed.options.get("max-cycles")), 10)
        : undefined,
    noSpawn: parsed.options.has("no-spawn"),
  });
  return true;
}
