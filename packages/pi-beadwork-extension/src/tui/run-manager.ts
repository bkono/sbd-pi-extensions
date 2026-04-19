import type { DashboardStatusSnapshot } from "./dashboard.js";

function formatIds(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

function describeRunScope(
  snapshot: Pick<DashboardStatusSnapshot, "state" | "scopeDetail">,
): string {
  if (snapshot.state.scope.kind === "epic") {
    const title = snapshot.state.scope.title ?? snapshot.scopeDetail?.title;
    return title ? `${snapshot.state.scope.id} · ${title}` : snapshot.state.scope.id;
  }

  return snapshot.state.recentRunSummary?.epicId ?? "no epic selected";
}

function describeRunState(snapshot: Pick<DashboardStatusSnapshot, "state">): string {
  if (snapshot.state.mode === "run") {
    return "active supervision armed";
  }

  const stopReason = snapshot.state.recentRunSummary?.stopReason;
  return stopReason ? `idle · last stop=${stopReason}` : "idle";
}

export function formatRunManagerLines(snapshot: DashboardStatusSnapshot): string[] {
  const options = snapshot.state.runOptions ?? snapshot.state.lastRunOptions;
  const summary = snapshot.state.recentRunSummary;
  const lines = [
    "Single-epic run panel.",
    `Run scope: ${describeRunScope(snapshot)}`,
    `Run state: ${describeRunState(snapshot)}`,
    options
      ? `Options: workers=${options.workers} until=${options.until} maxCycles=${options.maxCycles ?? "default"} dryRun=${options.dryRun ? "yes" : "no"} noSpawn=${options.noSpawn ? "yes" : "no"}`
      : "Options: not configured yet.",
    snapshot.counts && snapshot.state.scope.kind === "epic"
      ? `Scoped ready: ${snapshot.counts.scopedReady ?? 0}`
      : "Scoped ready: unavailable until an epic is selected.",
    snapshot.workerSummary
      ? `Workers: total=${snapshot.workerSummary.total} active=${snapshot.workerSummary.active} held=${snapshot.workerSummary.held} landed=${snapshot.workerSummary.landed} attention=${snapshot.workerSummary.attention} failed=${snapshot.workerSummary.failed}`
      : "Workers: no scoped worker summary yet.",
  ];

  if (!summary) {
    lines.push("", "Recent cycles: none yet.");
    return lines;
  }

  lines.push(
    "",
    `Recent result: cycles=${summary.cycles} launched=${formatIds(summary.launched)} activeWorkers=${formatIds(summary.activeWorkerIds)}`,
  );

  const recentCycles = summary.cycleSummaries.slice(-3);
  if (recentCycles.length === 0) {
    lines.push("Recent cycles: none recorded.");
    return lines;
  }

  lines.push("Recent cycles:");
  for (const cycle of recentCycles) {
    lines.push(
      `- cycle ${cycle.cycle} · ready=${formatIds(cycle.ready)} · launched=${formatIds(cycle.launched)} · running=${formatIds(cycle.running)} · held=${formatIds(cycle.held)} · landed=${formatIds(cycle.landed)} · failed=${formatIds(cycle.failed)}`,
    );
  }

  if (summary.notes.length > 0) {
    lines.push("", ...summary.notes.slice(-3).map((note) => `Note: ${note}`));
  }

  return lines;
}
