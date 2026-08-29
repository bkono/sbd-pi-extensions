import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ParsedArgv } from "../argv.js";
import type { BeadworkAdapter } from "../bw.js";
import { assertGoalModeConfig, SupervisorConfigError } from "../config.js";
import { DEFAULT_REVIEW_POLICY } from "../prompt.js";
import { updateStatusline } from "../statusline.js";
import {
  type ActivationState,
  type BeadworkConfig,
  type BeadworkIssueDetail,
  type Goal,
  isV1Goal,
  type ReviewPolicy,
  type SessionScope,
  type SessionState,
} from "../types.js";

export const PERSISTENT_HOST_MODES = ["tui", "rpc"] as const;

const REJECTED_RUN_FLAG_ALIASES = new Map<string, string>([
  ["workers", "workers"],
  ["until", "until"],
  ["max-cycles", "maxCycles"],
  ["maxCycles", "maxCycles"],
  ["no-spawn", "noSpawn"],
  ["noSpawn", "noSpawn"],
  ["dry-run", "dryRun"],
  ["dryRun", "dryRun"],
]);

const REJECTED_RUN_FLAG_HELP = "--workers, --until, --maxCycles, --noSpawn, --dryRun";

export type GoalPromptInjector = Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">;

export type RunActionDeps = {
  pi: GoalPromptInjector;
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

export type GoalInjectResult = {
  path: "sendUserMessage" | "sendMessage";
  busy: boolean;
};

export const runActionLog = {
  info(event: string, data: Record<string, unknown>): void {
    console.info(`[beadwork:run] ${event}`, data);
  },
};

export function isPersistentHost(mode: string | undefined): boolean {
  return (PERSISTENT_HOST_MODES as readonly string[]).includes(mode ?? "");
}

export function collectRejectedRunFlags(options: Map<string, string | true>): string[] {
  const rejected: string[] = [];
  for (const [name, canonical] of REJECTED_RUN_FLAG_ALIASES) {
    if (options.has(name) && !rejected.includes(canonical)) {
      rejected.push(canonical);
    }
  }
  return rejected;
}

export function createV1Goal(input: {
  epicId: string;
  reviewPolicy: ReviewPolicy;
  startedAt?: string;
  goalId?: string;
}): Goal {
  return {
    goalId: input.goalId ?? `goal-${input.epicId}`,
    scopeIds: [input.epicId],
    reviewPolicy: input.reviewPolicy,
    startedAt: input.startedAt ?? new Date().toISOString(),
  };
}

export function conflictingGoalEpicId(state: SessionState, epicId: string): string | undefined {
  if (state.mode !== "run" || !state.goal || !isV1Goal(state.goal)) {
    return undefined;
  }

  const current = state.goal.scopeIds[0];
  return current && current !== epicId ? current : undefined;
}

export function validateOpenEpicWithDescendants(epic: BeadworkIssueDetail): string | undefined {
  if (epic.type !== "epic") {
    return `/bw run requires an epic id. ${epic.id} is a ${epic.type}.`;
  }

  if (epic.status === "closed") {
    return `/bw run requires an open epic. ${epic.id} is closed.`;
  }

  if (epic.children.length === 0) {
    return `/bw run requires an open epic with traversable descendants. ${epic.id} has none.`;
  }

  return undefined;
}

export function buildGoalRunPrompt(input: {
  epicId: string;
  epicTitle: string;
  reviewPolicy: ReviewPolicy;
}): string {
  return [
    `Start beadwork goal mode for epic ${input.epicId} — ${input.epicTitle}.`,
    `Review policy: ${input.reviewPolicy}.`,
    "",
    "Refresh `bw` (ready/show) for current truth, then start ready work,",
    "compose each child's `task`, and `orchestrate` with domain metadata",
    '(source "beadwork", scopeId, workItemId, title).',
    "Do not treat this prompt as a frozen ready list.",
  ].join("\n");
}

export function injectGoalRunPrompt(
  pi: GoalPromptInjector,
  prompt: string,
  parentBusy: boolean,
): GoalInjectResult {
  if (parentBusy) {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    return { path: "sendUserMessage", busy: true };
  }

  pi.sendMessage(
    {
      customType: "beadwork-goal-run",
      content: prompt,
      display: true,
    },
    { triggerTurn: true },
  );
  return { path: "sendMessage", busy: false };
}

function notifyError(ctx: ExtensionCommandContext, message: string): void {
  ctx.ui.notify(message, "error");
}

function parentIsBusy(ctx: ExtensionCommandContext): boolean {
  return typeof ctx.isIdle === "function" ? !ctx.isIdle() : false;
}

export async function executeRunAction(input: {
  ctx: ExtensionCommandContext;
  deps: RunActionDeps;
  epicId: string;
}): Promise<void> {
  const { ctx, deps } = input;
  const active = await deps.requireActive(ctx);
  if (!active) {
    return;
  }

  if (!isPersistentHost(ctx.mode)) {
    runActionLog.info("reject-host", {
      epicId: input.epicId,
      hostMode: ctx.mode,
    });
    notifyError(
      ctx,
      `/bw run requires a persistent Pi host (tui or rpc). It is rejected in print and json.`,
    );
    return;
  }

  let config: BeadworkConfig;
  try {
    config = assertGoalModeConfig(ctx.cwd);
  } catch (error) {
    const message =
      error instanceof SupervisorConfigError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    runActionLog.info("reject-supervisor-config", {
      epicId: input.epicId,
      hostMode: ctx.mode,
      error: message,
    });
    notifyError(ctx, message);
    return;
  }

  const epic = await deps.adapter.show(ctx.cwd, input.epicId);
  const epicError = validateOpenEpicWithDescendants(epic);
  if (epicError) {
    runActionLog.info("reject-epic", {
      epicId: epic.id,
      hostMode: ctx.mode,
      reason: epicError,
    });
    ctx.ui.notify(epicError, "warning");
    return;
  }

  const conflictEpicId = conflictingGoalEpicId(active.state, epic.id);
  if (conflictEpicId) {
    runActionLog.info("reject-active-goal", {
      epicId: epic.id,
      hostMode: ctx.mode,
      activeEpicId: conflictEpicId,
    });
    notifyError(
      ctx,
      `Goal mode is already running for ${conflictEpicId}. Exit that goal before starting ${epic.id}.`,
    );
    return;
  }

  const reviewPolicy = config.review.policy ?? DEFAULT_REVIEW_POLICY;
  const existingGoal =
    active.state.mode === "run" &&
    active.state.goal &&
    isV1Goal(active.state.goal) &&
    active.state.goal.scopeIds[0] === epic.id
      ? active.state.goal
      : undefined;
  const goal = existingGoal ?? createV1Goal({ epicId: epic.id, reviewPolicy });
  const scope: Exclude<SessionScope, { kind: "none" }> = {
    kind: "epic",
    id: epic.id,
    title: epic.title,
  };

  const stateWithPrime = await deps.ensurePrime(
    ctx,
    active.activation,
    config,
    active.state,
    false,
  );
  const { state: preparedState } = await deps.setSessionMode(
    ctx,
    active.activation,
    config,
    stateWithPrime,
    "run",
    scope,
  );

  const persisted = await deps.writeSessionState(ctx, active.activation, config, {
    ...preparedState,
    mode: "run",
    scope,
    goal,
    runInterrupted: undefined,
    runOptions: undefined,
  });

  const prompt = buildGoalRunPrompt({
    epicId: epic.id,
    epicTitle: epic.title,
    reviewPolicy: goal.reviewPolicy,
  });
  const busy = parentIsBusy(ctx);
  const injected = injectGoalRunPrompt(deps.pi, prompt, busy);

  runActionLog.info("inject", {
    epicId: epic.id,
    hostMode: ctx.mode,
    injectPath: injected.path,
    busy: injected.busy,
  });

  ctx.ui.notify(`Goal mode started for ${epic.id}. The parent was asked to orchestrate.`, "info");
  updateStatusline(ctx, active.activation, persisted, config);
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

  const rejectedFlags = collectRejectedRunFlags(parsed.options);
  if (rejectedFlags.length > 0) {
    runActionLog.info("reject-flags", {
      rejectedFlags,
      hostMode: ctx.mode,
    });
    const listed = rejectedFlags.map((flag) => `--${flag}`).join(", ");
    notifyError(
      ctx,
      `/bw run no longer accepts supervisor flags (${REJECTED_RUN_FLAG_HELP}). ` +
        `Use \`/bw run <epic-id>\` only. Rejected: ${listed}.`,
    );
    return true;
  }

  if (!isPersistentHost(ctx.mode)) {
    runActionLog.info("reject-host", {
      hostMode: ctx.mode,
    });
    notifyError(
      ctx,
      `/bw run requires a persistent Pi host (tui or rpc). It is rejected in print and json.`,
    );
    return true;
  }

  const active = await deps.requireActive(ctx);
  if (!active) {
    return true;
  }

  const epicId =
    parsed.positional[0] ??
    (active.state.scope.kind === "epic" ? active.state.scope.id : undefined);
  if (!epicId) {
    ctx.ui.notify("Usage: /bw run <epic-id>", "info");
    return true;
  }

  await executeRunAction({
    ctx,
    deps,
    epicId,
  });
  return true;
}
