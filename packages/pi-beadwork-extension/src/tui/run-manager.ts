import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  kv,
  sectionTitle,
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
function formatIds(items: string[] | undefined): string {
  return items && items.length > 0 ? items.join(", ") : "none";
}
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

function describeRunState(theme: Theme, snapshot: Pick<DashboardStatusSnapshot, "state">): string {
  if (snapshot.state.mode === "run") {
    return styledSuccess(theme, "active supervision armed");
  }

  const stopReason = snapshot.state.recentRunSummary?.stopReason;
  if (!stopReason) {
    return styledDim(theme, "idle");
  }

  const reasonStyle =
    stopReason === "completed"
      ? styledSuccess(theme, stopReason)
      : stopReason === "blocked" || stopReason === "attention"
        ? styledError(theme, stopReason)
        : styledWarning(theme, stopReason);
  return `${styledDim(theme, "idle")} · last stop=${reasonStyle}`;
}
function describeRunNextAction(snapshot: Pick<DashboardStatusSnapshot, "state">): string {
  if (snapshot.state.mode === "run") {
    return "Background supervision is armed; use the Workers tab for live follow-up while the session stays open.";
  }

  const stopReason = snapshot.state.recentRunSummary?.stopReason;
  switch (stopReason) {
    case "completed":
      return "The last bounded run finished cleanly; pick another epic from Issues when you are ready.";
    case "blocked":
      return "The last run paused because no additional scoped ready work was available.";
    case "empty":
      return "The last run found no scoped ready work; retarget scope or wait for new ready tickets.";
    case "attention":
      return "The last run needs operator follow-up; open the Workers tab or run /bw workers for exact diagnostics.";
    case "max-cycles":
      return "The bounded loop hit max cycles; background supervision keeps checking on later idle turns.";
    default:
      return "Pick an epic in Issues and press r, or run /bw run <epic-id>.";
  }
}

export function formatRunManagerLines(snapshot: DashboardStatusSnapshot, theme?: Theme): string[] {
  const t = theme ?? passthroughTheme;
  const options = snapshot.state.runOptions ?? snapshot.state.lastRunOptions;
  const summary = snapshot.state.recentRunSummary;
  const lines = [
    styledDim(t, "Run panel · single-epic orchestration."),
    `${kv(t, "Run scope", describeRunScope(t, snapshot))}`,
    `${kv(t, "Run state", describeRunState(t, snapshot))}`,
    `${kv(t, "Next", describeRunNextAction(snapshot))}`,
    options
      ? `${kv(t, "Options", `workers=${options.workers} until=${options.until} maxCycles=${options.maxCycles ?? "default"} dryRun=${options.dryRun ? "yes" : "no"} noSpawn=${options.noSpawn ? "yes" : "no"}`)}`
      : kv(t, "Options", styledDim(t, "not configured yet.")),
    snapshot.counts && snapshot.state.scope.kind === "epic"
      ? kv(t, "Scoped ready", String(snapshot.counts.scopedReady ?? 0))
      : kv(t, "Scoped ready", styledDim(t, "unavailable until an epic is selected.")),
    snapshot.workerSummary
      ? `${kv(t, "Tracked workers", `total=${snapshot.workerSummary.total} active=${snapshot.workerSummary.active} held=${snapshot.workerSummary.held} done=${snapshot.workerSummary.successfulTerminal} landed=${snapshot.workerSummary.landed} verified=${snapshot.workerSummary.verified} attention=${snapshot.workerSummary.attention} failed=${snapshot.workerSummary.failed}`)}`
      : kv(t, "Workers", styledDim(t, "no scoped worker summary yet.")),
  ];
  if (!summary) {
    lines.push("", styledDim(t, "Recent cycles: none yet."));
    return lines;
  }

  lines.push(
    "",
    sectionTitle(t, "Recent result"),
    `cycles=${summary.cycles} launched=${formatIds(summary.launched)} activeWorkers=${formatIds(summary.activeWorkerIds)}`,
  );
  const recentCycles = summary.cycleSummaries.slice(-3);
  if (recentCycles.length === 0) {
    lines.push(styledDim(t, "Recent cycles: none recorded."));
    return lines;
  }
  lines.push(sectionTitle(t, "Recent cycles"));
  for (const cycle of recentCycles) {
    lines.push(
      `${styledDim(t, "-")} cycle ${cycle.cycle} · ready=${formatIds(cycle.ready)} · launched=${formatIds(cycle.launched)} · running=${formatIds(cycle.running)} · held=${formatIds(cycle.held)} · landed=${formatIds(cycle.landed)} · verified=${formatIds(cycle.verified)} · failed=${formatIds(cycle.failed)}`,
    );
  }
  if (summary.notes.length > 0) {
    lines.push(
      "",
      sectionTitle(t, "Notes"),
      ...summary.notes.slice(-3).map((note) => `${styledDim(t, "Note:")} ${note}`),
    );
  }

  return lines;
}
