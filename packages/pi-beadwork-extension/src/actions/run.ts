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
};

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

  const epic = await deps.adapter.show(ctx.cwd, epicId);
  if (epic.type !== "epic") {
    ctx.ui.notify(`/bw run requires an epic id. ${epicId} is a ${epic.type}.`, "warning");
    return true;
  }

  const stateWithPrime = await deps.ensurePrime(
    ctx,
    active.activation,
    active.config,
    active.state,
    false,
  );
  const options = buildRunOptions(active.config, {
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
  const scope: Exclude<SessionScope, { kind: "none" }> = {
    kind: "epic",
    id: epic.id,
    title: epic.title,
  };
  const { state } = options.dryRun
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
        {
          workers: options.workers,
          until: options.until,
          noSpawn: options.noSpawn,
          dryRun: false,
        },
      );

  const summary = await runBoundedEpicLoop({
    cwd: ctx.cwd,
    repoRoot: active.activation.repoRoot ?? ctx.cwd,
    config: active.config,
    adapter: deps.adapter,
    epicId: epic.id,
    options,
    prime: state.prime?.content,
  });
  await showRunSummary(ctx, summary);
  if (!options.dryRun && summary.stopReason === "max-cycles") {
    ctx.ui.notify(
      `Background supervision remains armed for ${epic.id}; it will keep polling every ${Math.round(active.config.supervisor.pollIntervalMs / 1000)}s while work is still active.`,
      "info",
    );
  }
  updateStatusline(ctx, active.activation, state, active.config, summary.workerSummary);
  return true;
}
