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

export type GoalStartState = "started" | "resumed";

export type GoalContinuationDisposition = "queued_follow_up" | "triggered_turn";

export type GoalStartErrorCode = "inactive" | "host" | "supervisor" | "epic" | "conflict";

export class GoalStartError extends Error {
  readonly code: GoalStartErrorCode;

  constructor(code: GoalStartErrorCode, message: string) {
    super(message);
    this.name = "GoalStartError";
    this.code = code;
  }
}

export type GoalStartSession = {
  activation: ActivationState;
  state: SessionState;
};

export type GoalStartResult = {
  epicId: string;
  epicTitle: string;
  goal: Goal;
  state: GoalStartState;
  continuation: GoalContinuationDisposition;
  prompt: string;
};

export type GoalStartToolResult = {
  epic_id: string;
  epic_title: string;
  goal_id: string;
  review_policy: ReviewPolicy;
  state: GoalStartState;
  continuation: GoalContinuationDisposition;
};

export function toGoalStartToolResult(result: GoalStartResult): GoalStartToolResult {
  return {
    epic_id: result.epicId,
    epic_title: result.epicTitle,
    goal_id: result.goal.goalId,
    review_policy: result.goal.reviewPolicy,
    state: result.state,
    continuation: result.continuation,
  };
}

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
    return `Goal mode requires an epic id. ${epic.id} is a ${epic.type}.`;
  }

  if (epic.status === "closed") {
    return `Goal mode requires an open epic. ${epic.id} is closed.`;
  }

  if (epic.children.length === 0) {
    return `Goal mode requires an open epic with traversable descendants. ${epic.id} has none.`;
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

export function parentIsBusy(ctx: { isIdle?: () => boolean }): boolean {
  return typeof ctx.isIdle === "function" ? !ctx.isIdle() : false;
}

export function injectParentContinuation(
  pi: GoalPromptInjector,
  prompt: string,
  parentBusy: boolean,
  customType: string,
): GoalInjectResult {
  if (parentBusy) {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    return { path: "sendUserMessage", busy: true };
  }

  pi.sendMessage(
    {
      customType,
      content: prompt,
      display: true,
    },
    { triggerTurn: true },
  );
  return { path: "sendMessage", busy: false };
}

export function injectGoalRunPrompt(
  pi: GoalPromptInjector,
  prompt: string,
  parentBusy: boolean,
): GoalInjectResult {
  return injectParentContinuation(pi, prompt, parentBusy, "beadwork-goal-run");
}

function notifyError(ctx: ExtensionCommandContext, message: string): void {
  ctx.ui.notify(message, "error");
}

function presentGoalStartError(ctx: ExtensionCommandContext, error: GoalStartError): void {
  if (error.code === "epic") {
    ctx.ui.notify(error.message, "warning");
    return;
  }
  notifyError(ctx, error.message);
}

export async function startGoal(input: {
  ctx: ExtensionCommandContext;
  deps: RunActionDeps;
  epicId: string;
  session: GoalStartSession;
}): Promise<GoalStartResult> {
  const { ctx, deps, session } = input;
  const epicId = typeof input.epicId === "string" ? input.epicId.trim() : "";
  if (!epicId) {
    throw new GoalStartError("epic", "Goal mode requires an explicit epic id.");
  }

  if (session.activation.kind !== "active") {
    throw new GoalStartError("inactive", "Beadwork is not active in this repository.");
  }

  if (!isPersistentHost(ctx.mode)) {
    runActionLog.info("reject-host", {
      epicId,
      hostMode: ctx.mode,
    });
    throw new GoalStartError(
      "host",
      "Goal mode requires a persistent Pi host (tui or rpc). It is rejected in print and json.",
    );
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
      epicId,
      hostMode: ctx.mode,
      error: message,
    });
    throw new GoalStartError("supervisor", message);
  }

  const epic = await deps.adapter.show(ctx.cwd, epicId);
  const epicError = validateOpenEpicWithDescendants(epic);
  if (epicError) {
    runActionLog.info("reject-epic", {
      epicId: epic.id,
      hostMode: ctx.mode,
      reason: epicError,
    });
    throw new GoalStartError("epic", epicError);
  }

  const conflictEpicId = conflictingGoalEpicId(session.state, epic.id);
  if (conflictEpicId) {
    runActionLog.info("reject-active-goal", {
      epicId: epic.id,
      hostMode: ctx.mode,
      activeEpicId: conflictEpicId,
    });
    throw new GoalStartError(
      "conflict",
      `Goal mode is already running for ${conflictEpicId}. Exit that goal before starting ${epic.id}.`,
    );
  }

  const reviewPolicy = config.review.policy ?? DEFAULT_REVIEW_POLICY;
  const existingGoal =
    session.state.mode === "run" &&
    session.state.goal &&
    isV1Goal(session.state.goal) &&
    session.state.goal.scopeIds[0] === epic.id
      ? session.state.goal
      : undefined;
  const goal = existingGoal ?? createV1Goal({ epicId: epic.id, reviewPolicy });
  const scope: Exclude<SessionScope, { kind: "none" }> = {
    kind: "epic",
    id: epic.id,
    title: epic.title,
  };

  const stateWithPrime = await deps.ensurePrime(
    ctx,
    session.activation,
    config,
    session.state,
    false,
  );
  const { state: preparedState } = await deps.setSessionMode(
    ctx,
    session.activation,
    config,
    stateWithPrime,
    "run",
    scope,
  );

  const persisted = await deps.writeSessionState(ctx, session.activation, config, {
    ...preparedState,
    mode: "run",
    scope,
    goal,
    runInterrupted: undefined,
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

  updateStatusline(ctx, session.activation, persisted, config);

  return {
    epicId: epic.id,
    epicTitle: epic.title,
    goal,
    state: existingGoal ? "resumed" : "started",
    continuation: injected.busy ? "queued_follow_up" : "triggered_turn",
    prompt,
  };
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

  try {
    const result = await startGoal({
      ctx,
      deps,
      epicId: input.epicId,
      session: {
        activation: active.activation,
        state: active.state,
      },
    });
    ctx.ui.notify(
      `Goal mode started for ${result.epicId}. The parent was asked to orchestrate.`,
      "info",
    );
  } catch (error) {
    if (error instanceof GoalStartError) {
      presentGoalStartError(ctx, error);
      return;
    }
    throw error;
  }
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
