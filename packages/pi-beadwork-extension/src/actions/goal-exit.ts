import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dropGoalMode } from "../session-state.js";
import { updateStatusline } from "../statusline.js";
import type { ActivationState, BeadworkConfig, BeadworkIssue, SessionState } from "../types.js";
import { isV1Goal } from "../types.js";
import {
  type GoalInjectResult,
  type GoalPromptInjector,
  injectParentContinuation,
  parentIsBusy,
} from "./run.js";

export const GOAL_HALT_CUSTOM_TYPE = "beadwork-goal-halt";

export type GoalExitCommand = "beadwork_close_issue" | "abandon" | "close";

export type GoalExitDeps = {
  pi: GoalPromptInjector;
  writeSessionState: (
    ctx: ExtensionContext,
    activation: ActivationState,
    config: BeadworkConfig,
    state: SessionState,
  ) => Promise<SessionState>;
};

export const goalExitLog = {
  info(event: string, data: Record<string, unknown>): void {
    console.info(`[beadwork:goal-exit] ${event}`, data);
  },
};

export function scopedGoalEpicId(state: SessionState): string | undefined {
  if (state.mode !== "run") {
    return undefined;
  }

  if (state.goal && isV1Goal(state.goal)) {
    return state.goal.scopeIds[0];
  }

  return state.scope.kind === "epic" ? state.scope.id : undefined;
}

export function shouldExitGoalOnIssueClose(
  state: SessionState,
  issue: Pick<BeadworkIssue, "id" | "type">,
): boolean {
  const epicId = scopedGoalEpicId(state);
  return Boolean(epicId && issue.type === "epic" && issue.id === epicId);
}

export function shouldExitGoalOnClosedScopeDetail(
  state: SessionState,
  scopeDetail: Pick<BeadworkIssue, "id" | "type" | "status"> | undefined,
): boolean {
  return Boolean(
    scopeDetail &&
      scopeDetail.status === "closed" &&
      shouldExitGoalOnIssueClose(state, scopeDetail),
  );
}

export function buildGoalHaltPrompt(epicId: string): string {
  return [
    `Beadwork goal mode ended for epic ${epicId}.`,
    'Call minions halt with id "group" (halt tool id="group", or /halt group)',
    "to abort live orchestrated children and forget the open group.",
    "Do not orchestrate further work for this goal.",
  ].join("\n");
}

export function injectGoalHaltContinuation(
  pi: GoalPromptInjector,
  prompt: string,
  parentBusy: boolean,
): GoalInjectResult {
  return injectParentContinuation(pi, prompt, parentBusy, GOAL_HALT_CUSTOM_TYPE);
}

function logGoalExit(data: {
  command: string;
  epicId?: string;
  previousMode: SessionState["mode"];
  newMode: SessionState["mode"];
  haltContinuationQueued: boolean;
  injectPath?: GoalInjectResult["path"];
  busy?: boolean;
  reason?: string;
}): void {
  goalExitLog.info("exit", data);
}

export async function exitGoalMode(input: {
  ctx: ExtensionContext;
  activation: ActivationState;
  config: BeadworkConfig;
  state: SessionState;
  deps: GoalExitDeps;
  command: GoalExitCommand;
  epicId: string;
  parentBusy: boolean;
}): Promise<SessionState> {
  const previousMode = input.state.mode;
  const persisted = await input.deps.writeSessionState(
    input.ctx,
    input.activation,
    input.config,
    dropGoalMode(input.state),
  );

  let haltContinuationQueued = false;
  let injectPath: GoalInjectResult["path"] | undefined;
  try {
    const injected = injectGoalHaltContinuation(
      input.deps.pi,
      buildGoalHaltPrompt(input.epicId),
      input.parentBusy,
    );
    haltContinuationQueued = true;
    injectPath = injected.path;
  } catch (error) {
    goalExitLog.info("inject-failed", {
      command: input.command,
      epicId: input.epicId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logGoalExit({
    command: input.command,
    epicId: input.epicId,
    previousMode,
    newMode: persisted.mode,
    haltContinuationQueued,
    injectPath,
    busy: input.parentBusy,
  });

  input.ctx.ui.notify(
    `Goal mode ended for ${input.epicId}. The parent was asked to halt the minion group.`,
    "info",
  );
  updateStatusline(input.ctx, input.activation, persisted, input.config);
  return persisted;
}

export async function maybeExitGoalOnClosedIssue(input: {
  ctx: ExtensionContext;
  activation: ActivationState;
  config: BeadworkConfig;
  state: SessionState;
  issue: Pick<BeadworkIssue, "id" | "type">;
  deps: GoalExitDeps;
  command: Exclude<GoalExitCommand, "abandon">;
  parentBusy: boolean;
}): Promise<SessionState> {
  const epicId = scopedGoalEpicId(input.state);
  if (!epicId || !shouldExitGoalOnIssueClose(input.state, input.issue)) {
    if (input.state.mode === "run") {
      logGoalExit({
        command: input.command,
        epicId,
        previousMode: input.state.mode,
        newMode: input.state.mode,
        haltContinuationQueued: false,
        reason: "not-scoped-epic",
      });
    }
    return input.state;
  }

  return exitGoalMode({
    ctx: input.ctx,
    activation: input.activation,
    config: input.config,
    state: input.state,
    deps: input.deps,
    command: input.command,
    epicId,
    parentBusy: input.parentBusy,
  });
}

export async function maybeExitGoalOnClosedScopeDetail(input: {
  ctx: ExtensionContext;
  activation: ActivationState;
  config: BeadworkConfig;
  state: SessionState;
  scopeDetail?: Pick<BeadworkIssue, "id" | "type" | "status">;
  deps: GoalExitDeps;
  parentBusy: boolean;
}): Promise<SessionState> {
  if (!shouldExitGoalOnClosedScopeDetail(input.state, input.scopeDetail) || !input.scopeDetail) {
    return input.state;
  }

  return maybeExitGoalOnClosedIssue({
    ctx: input.ctx,
    activation: input.activation,
    config: input.config,
    state: input.state,
    issue: input.scopeDetail,
    deps: input.deps,
    command: "close",
    parentBusy: input.parentBusy,
  });
}

export type AbandonActionDeps = GoalExitDeps & {
  requireActive: (ctx: ExtensionCommandContext) => Promise<{
    activation: ActivationState;
    config: BeadworkConfig;
    state: SessionState;
  } | null>;
};

export async function handleAbandonAction(input: {
  subcommand: string;
  ctx: ExtensionCommandContext;
  deps: AbandonActionDeps;
}): Promise<boolean> {
  if (input.subcommand !== "abandon") {
    return false;
  }

  const active = await input.deps.requireActive(input.ctx);
  if (!active) {
    return true;
  }

  const epicId = scopedGoalEpicId(active.state);
  if (!epicId) {
    logGoalExit({
      command: "abandon",
      previousMode: active.state.mode,
      newMode: active.state.mode,
      haltContinuationQueued: false,
      reason: "not-run",
    });
    input.ctx.ui.notify("Goal mode is not active.", "info");
    return true;
  }

  await exitGoalMode({
    ctx: input.ctx,
    activation: active.activation,
    config: active.config,
    state: active.state,
    deps: input.deps,
    command: "abandon",
    epicId,
    parentBusy: parentIsBusy(input.ctx),
  });
  return true;
}
