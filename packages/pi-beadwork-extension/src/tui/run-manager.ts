import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  kv,
  styledAccent,
  styledDim,
  styledError,
  styledSuccess,
  styledWarning,
} from "./common.js";
import type { DashboardStatusSnapshot } from "./dashboard.js";

/** Fallback theme that returns text unchanged */
const passthroughTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function describeRunScope(
  theme: Theme,
  snapshot: Pick<DashboardStatusSnapshot, "state" | "scopeDetail">,
): string {
  if (snapshot.state.scope.kind === "epic") {
    const title = snapshot.state.scope.title ?? snapshot.scopeDetail?.title;
    return title
      ? `${styledAccent(theme, snapshot.state.scope.id)} · ${title}`
      : styledAccent(theme, snapshot.state.scope.id);
  }

  return snapshot.state.recentRunSummary?.epicId
    ? styledAccent(theme, snapshot.state.recentRunSummary.epicId)
    : styledDim(theme, "no epic selected");
}

function describeReviewPolicy(
  theme: Theme,
  snapshot: Pick<DashboardStatusSnapshot, "config">,
): string {
  const config = snapshot.config;
  if (!config) {
    return styledDim(theme, "unavailable");
  }

  return config.review.policy === "none"
    ? styledDim(theme, "none")
    : styledAccent(theme, config.review.policy);
}

function describeGoalState(theme: Theme, snapshot: Pick<DashboardStatusSnapshot, "state">): string {
  if (snapshot.state.mode === "run") {
    return styledSuccess(theme, "active");
  }

  const stopReason = snapshot.state.recentRunSummary?.stopReason;
  if (stopReason && stopReason !== "completed") {
    const reasonStyle =
      stopReason === "blocked" || stopReason === "attention"
        ? styledError(theme, stopReason)
        : styledWarning(theme, stopReason);
    return `${styledWarning(theme, "interrupted")} · last stop=${reasonStyle}`;
  }

  if (stopReason === "completed") {
    return `${styledDim(theme, "idle")} · last stop=${styledSuccess(theme, stopReason)}`;
  }

  return styledDim(theme, "idle");
}

function describeGoalNextAction(snapshot: Pick<DashboardStatusSnapshot, "state">): string {
  if (snapshot.state.mode === "run") {
    return "Goal mode is active; the session appendix stays armed until the epic is closed or abandoned.";
  }

  const stopReason = snapshot.state.recentRunSummary?.stopReason;
  switch (stopReason) {
    case "completed":
      return "The last goal finished; pick another epic from Issues when you are ready.";
    case "blocked":
      return "The last run paused because no additional scoped ready work was available.";
    case "empty":
      return "The last run found no scoped ready work; retarget scope or wait for new ready tickets.";
    case "attention":
      return "The last run needs operator follow-up; resume from Issues or /bw run <epic-id>.";
    case "max-cycles":
      return "The last run hit its cycle bound; resume with /bw run <epic-id> if the epic is still open.";
    default:
      return "Pick an epic in Issues and press r, or run /bw run <epic-id>.";
  }
}

export function formatRunManagerLines(snapshot: DashboardStatusSnapshot, theme?: Theme): string[] {
  const t = theme ?? passthroughTheme;
  return [
    styledDim(t, "Goal summary · epic, review policy, and run state."),
    kv(t, "Epic", describeRunScope(t, snapshot)),
    kv(t, "Review policy", describeReviewPolicy(t, snapshot)),
    kv(t, "Goal state", describeGoalState(t, snapshot)),
    kv(t, "Next", describeGoalNextAction(snapshot)),
  ];
}
