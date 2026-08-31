import type { Theme } from "@earendil-works/pi-coding-agent";
import { isInterruptedRun } from "../session-state.js";
import { kv, styledAccent, styledDim, styledSuccess, styledWarning } from "./common.js";
import type { DashboardStatusSnapshot } from "./dashboard.js";

/** Fallback theme that returns text unchanged. */
const passthroughTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function describeGoalScope(
  theme: Theme,
  snapshot: Pick<DashboardStatusSnapshot, "state" | "scopeDetail">,
): string {
  if (snapshot.state.scope.kind !== "epic") {
    return styledDim(theme, "no epic selected");
  }

  const title = snapshot.state.scope.title ?? snapshot.scopeDetail?.title;
  return title
    ? `${styledAccent(theme, snapshot.state.scope.id)} · ${title}`
    : styledAccent(theme, snapshot.state.scope.id);
}

function describeReviewPolicy(
  theme: Theme,
  snapshot: Pick<DashboardStatusSnapshot, "state" | "config">,
): string {
  const policy = snapshot.state.goal?.reviewPolicy ?? snapshot.config?.review.policy;
  if (!policy) {
    return styledDim(theme, "unavailable");
  }
  return policy === "none" ? styledDim(theme, policy) : styledAccent(theme, policy);
}

function describeGoalMode(theme: Theme, snapshot: Pick<DashboardStatusSnapshot, "state">): string {
  if (isInterruptedRun(snapshot.state)) {
    return styledWarning(theme, "interrupted");
  }
  if (snapshot.state.mode === "run") {
    return styledSuccess(theme, "active");
  }
  return styledDim(theme, "inactive");
}

function describeNextAction(snapshot: Pick<DashboardStatusSnapshot, "state">): string {
  if (isInterruptedRun(snapshot.state)) {
    return "Resume only with an explicit /bw run <epic-id>, or abandon the interrupted goal.";
  }
  if (snapshot.state.mode === "run") {
    return "The goal appendix remains active until the epic closes or the parent abandons it.";
  }
  return "Select an open epic in Issues and press r, or run /bw run <epic-id>.";
}

export function formatGoalModeLines(snapshot: DashboardStatusSnapshot, theme?: Theme): string[] {
  const t = theme ?? passthroughTheme;
  return [
    styledDim(t, "Current explicit goal-mode entry and review policy."),
    kv(t, "Epic", describeGoalScope(t, snapshot)),
    kv(t, "Review policy", describeReviewPolicy(t, snapshot)),
    kv(t, "Goal mode", describeGoalMode(t, snapshot)),
    kv(t, "Next", describeNextAction(snapshot)),
  ];
}
