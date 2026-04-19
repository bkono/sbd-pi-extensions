import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { summarizeWorkers } from "../registry.js";
import type { ActivationState, SessionState, WorkerRuntime } from "../types.js";
import { inspectWorker, type WorkerInspection } from "../worker-diagnostics.js";

export type WorkerActionKind = "land" | "cancel" | "cleanup";

export type WorkerActionAvailability = {
  kind: WorkerActionKind;
  label: string;
  command: string;
  enabled: boolean;
  reason: string;
};

export type WorkerActionSet = Record<WorkerActionKind, WorkerActionAvailability>;

export type WorkerManagerEntry = {
  worker: WorkerRuntime;
  inspection: WorkerInspection;
  actions: WorkerActionSet;
};

export type WorkerManagerGroup = {
  id: string;
  kind: "epic" | "background";
  label: string;
  description: string;
  summary: ReturnType<typeof summarizeWorkers>;
  attention: number;
  workers: WorkerManagerEntry[];
};

export type WorkerManagerModel = {
  cwd: string;
  activation: ActivationState;
  state: SessionState;
  workers: WorkerRuntime[];
  epicId?: string;
};

const STATUS_PRIORITY: Record<WorkerRuntime["status"], number> = {
  attention: 0,
  failed: 1,
  running: 2,
  launching: 3,
  held: 4,
  exited: 5,
  landed: 6,
};

function compareWorkerEntries(left: WorkerManagerEntry, right: WorkerManagerEntry): number {
  if (left.inspection.followUp.needsAttention !== right.inspection.followUp.needsAttention) {
    return left.inspection.followUp.needsAttention ? -1 : 1;
  }

  const leftActive = left.worker.status === "launching" || left.worker.status === "running";
  const rightActive = right.worker.status === "launching" || right.worker.status === "running";
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1;
  }

  const statusDelta = STATUS_PRIORITY[left.worker.status] - STATUS_PRIORITY[right.worker.status];
  if (statusDelta !== 0) {
    return statusDelta;
  }

  return right.worker.startedAt.localeCompare(left.worker.startedAt);
}

function formatActionState(action: WorkerActionAvailability): string {
  return `${action.label}:${action.enabled ? "ready" : `blocked (${action.reason})`}`;
}

function formatTmuxTarget(worker: WorkerRuntime): string {
  return `${worker.tmuxSession}:${worker.tmuxWindow}.${worker.tmuxPane}`;
}

function selectDefaultWorker(
  groups: WorkerManagerGroup[],
  selectedWorkerId?: string,
): WorkerManagerEntry | undefined {
  if (selectedWorkerId) {
    for (const group of groups) {
      const match = group.workers.find((entry) => entry.worker.workerId === selectedWorkerId);
      if (match) {
        return match;
      }
    }
  }

  return groups.flatMap((group) => group.workers)[0];
}

export function getWorkerActionAvailability(worker: WorkerRuntime): WorkerActionSet {
  const inspection = inspectWorker(worker);

  const land: WorkerActionAvailability = {
    kind: "land",
    label: "land",
    command: `/bw land ${worker.ticketId}`,
    enabled: false,
    reason: "not ready",
  };

  if (worker.landingRequestedAt && !worker.landingVerifiedAt) {
    land.reason = "landing already queued";
  } else if (worker.status === "landed" || inspection.landing.state === "verified") {
    land.reason = "already landed";
  } else if (worker.status === "launching" || worker.status === "running") {
    land.reason = "worker is still active";
  } else if (worker.ticketStatus !== "closed") {
    land.reason = "ticket must be closed first";
  } else if (worker.status === "failed") {
    land.reason = "worker failed; relaunch after fixing it";
  } else if (inspection.validation.state === "failed") {
    land.reason = inspection.validation.detail ?? "validation is failing";
  } else if (
    inspection.review.state === "changes-requested" ||
    inspection.review.state === "review-blocked"
  ) {
    land.reason = inspection.review.detail ?? "review requested additional changes";
  } else if (worker.status === "attention" && inspection.landing.state === "needs-attention") {
    land.reason = inspection.followUp.action;
  } else {
    land.enabled = true;
    land.reason =
      inspection.landing.state === "needs-refresh"
        ? "re-run merge-back checks and refresh the held branch"
        : inspection.landing.state === "ready-to-land" || worker.status === "held"
          ? "merge back the held worker branch"
          : "queue merge-back checks for this worker";
  }

  const cancel: WorkerActionAvailability = {
    kind: "cancel",
    label: "cancel",
    command: `/bw cancel ${worker.workerId}`,
    enabled: worker.status === "launching" || worker.status === "running",
    reason:
      worker.status === "launching" || worker.status === "running"
        ? "stop the active worker"
        : "only launching/running workers can be cancelled",
  };

  const cleanup: WorkerActionAvailability = {
    kind: "cleanup",
    label: "cleanup",
    command: `/bw cleanup ${worker.ticketId}`,
    enabled: false,
    reason: "not ready",
  };

  if (worker.status === "launching" || worker.status === "running") {
    cleanup.reason = "worker is still active";
  } else if (worker.cleanupStatus === "cleaned") {
    cleanup.reason = "already cleaned";
  } else if (worker.cleanupPolicy !== "keep") {
    cleanup.reason = `cleanup policy is ${worker.cleanupPolicy}`;
  } else if (!worker.landingVerifiedAt && worker.status !== "landed") {
    cleanup.reason = "landing must be verified or marked landed first";
  } else {
    cleanup.enabled = true;
    cleanup.reason = "remove retained worktree/runtime artifacts";
  }

  return { land, cancel, cleanup };
}

function buildGroupDescriptor(
  worker: WorkerRuntime,
  state: SessionState,
): {
  id: string;
  kind: WorkerManagerGroup["kind"];
  label: string;
  description: string;
  sortRank: number;
} {
  const tracked = state.mode === "neutral" && state.trackedWorkerIds?.includes(worker.workerId);
  if (tracked || !worker.epicId) {
    return {
      id: "background",
      kind: "background",
      label: "Manual / background",
      description:
        "Workers being tracked outside an active run, including manual delegation and held follow-up.",
      sortRank: 0,
    };
  }

  const currentScope = state.scope.kind === "epic" && state.scope.id === worker.epicId;
  return {
    id: `epic:${worker.epicId}`,
    kind: "epic",
    label: currentScope ? `Epic ${worker.epicId} (current scope)` : `Epic ${worker.epicId}`,
    description: currentScope
      ? "Workers grouped under the currently scoped epic."
      : "Workers grouped by epic/run metadata.",
    sortRank: currentScope ? 1 : 2,
  };
}

export function groupWorkersForManager(input: {
  workers: WorkerRuntime[];
  state: SessionState;
}): WorkerManagerGroup[] {
  const groups = new Map<
    string,
    WorkerManagerGroup & {
      sortRank: number;
      newestStartedAt?: string;
    }
  >();

  for (const worker of input.workers) {
    const descriptor = buildGroupDescriptor(worker, input.state);
    const inspection = inspectWorker(worker);
    const entry: WorkerManagerEntry = {
      worker,
      inspection,
      actions: getWorkerActionAvailability(worker),
    };

    const group = groups.get(descriptor.id) ?? {
      id: descriptor.id,
      kind: descriptor.kind,
      label: descriptor.label,
      description: descriptor.description,
      summary: summarizeWorkers([]),
      attention: 0,
      workers: [],
      sortRank: descriptor.sortRank,
      newestStartedAt: undefined,
    };

    group.workers.push(entry);
    if (inspection.followUp.needsAttention) {
      group.attention += 1;
    }
    if (!group.newestStartedAt || worker.startedAt > group.newestStartedAt) {
      group.newestStartedAt = worker.startedAt;
    }
    groups.set(descriptor.id, group);
  }

  return [...groups.values()]
    .map((group) => {
      group.workers.sort(compareWorkerEntries);
      group.summary = summarizeWorkers(group.workers.map((entry) => entry.worker));
      return group;
    })
    .sort((left, right) => {
      if (left.sortRank !== right.sortRank) {
        return left.sortRank - right.sortRank;
      }
      return (right.newestStartedAt ?? "").localeCompare(left.newestStartedAt ?? "");
    })
    .map(({ sortRank: _sortRank, newestStartedAt: _newestStartedAt, ...group }) => group);
}

export function buildWorkerDetailLines(entry: WorkerManagerEntry): string[] {
  const { worker, inspection, actions } = entry;
  return [
    `Selected: ${worker.ticketId} · ${worker.status} · ${worker.ticketTitle}`,
    `Progress: ticket=${worker.ticketStatus ?? "unknown"} · validation=${inspection.validation.summary} · review=${inspection.review.summary} · landing=${inspection.landing.summary} · cleanup=${inspection.cleanup.summary}`,
    `Next: ${inspection.followUp.action}`,
    `Actions: ${formatActionState(actions.land)} · ${formatActionState(actions.cancel)} · ${formatActionState(actions.cleanup)}`,
    `Commands: /bw land ${worker.ticketId} · /bw cancel ${worker.workerId} · /bw cleanup ${worker.ticketId}`,
    `Tmux: ${formatTmuxTarget(worker)}`,
    `Paths: log=${worker.logFile} · runtime=${worker.runtimeDir}`,
    `Files: state=${worker.stateFile} · prompt=${worker.promptFile} · script=${worker.scriptFile}`,
    `Worktree: ${worker.worktreePath}`,
  ];
}

export function buildWorkerManagerPanelLines(input: {
  workers: WorkerRuntime[];
  state: SessionState;
  selectedWorkerId?: string;
  maxWorkersPerGroup?: number;
}): string[] {
  const groups = groupWorkersForManager({ workers: input.workers, state: input.state });
  if (groups.length === 0) {
    return [
      "No beadwork workers are currently tracked.",
      "Open /bw and use the Issues tab to delegate, or run /bw run <epic-id> to launch bounded work.",
    ];
  }

  const selected = selectDefaultWorker(groups, input.selectedWorkerId);
  const lines: string[] = ["Worker groups:"];
  const maxWorkersPerGroup = input.maxWorkersPerGroup ?? Number.POSITIVE_INFINITY;

  for (const group of groups) {
    lines.push(
      `- ${group.label} · total=${group.summary.total} active=${group.summary.active} held=${group.summary.held} landed=${group.summary.landed} attention=${group.attention}`,
    );
    lines.push(`  ${group.description}`);

    const visibleWorkers = group.workers.slice(0, maxWorkersPerGroup);
    for (const entry of visibleWorkers) {
      const marker = selected?.worker.workerId === entry.worker.workerId ? "●" : "○";
      lines.push(
        `  ${marker} ${entry.worker.ticketId} · ${entry.worker.status} · validation:${entry.inspection.validation.summary} · review:${entry.inspection.review.summary} · landing:${entry.inspection.landing.summary}`,
      );
    }

    if (group.workers.length > visibleWorkers.length) {
      lines.push(`  … ${group.workers.length - visibleWorkers.length} more worker(s)`);
    }
  }

  if (selected) {
    lines.push("", ...buildWorkerDetailLines(selected));
  }

  return lines;
}

class WorkerManagerComponent implements Component {
  private readonly groups: WorkerManagerGroup[];
  private readonly entries: WorkerManagerEntry[];
  private selectedIndex = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly model: WorkerManagerModel,
    private readonly done: (result: undefined) => void,
  ) {
    this.groups = groupWorkersForManager({ workers: model.workers, state: model.state });
    this.entries = this.groups.flatMap((group) => group.workers);
  }

  private requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.entries.length > 0 && (matchesKey(data, Key.up) || matchesKey(data, "k"))) {
      this.selectedIndex = (this.selectedIndex + this.entries.length - 1) % this.entries.length;
      this.requestRender();
      return;
    }

    if (this.entries.length > 0 && (matchesKey(data, Key.down) || matchesKey(data, "j"))) {
      this.selectedIndex = (this.selectedIndex + 1) % this.entries.length;
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
      this.done(undefined);
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const summary = summarizeWorkers(this.model.workers);
    const selectedWorkerId = this.entries[this.selectedIndex]?.worker.workerId;
    const bodyLines = buildWorkerManagerPanelLines({
      workers: this.model.workers,
      state: this.model.state,
      selectedWorkerId,
    });
    const headerLines = [
      this.theme.fg("accent", this.theme.bold("Beadwork Worker Manager")),
      `Repo: ${this.model.activation.repoRoot ?? this.model.cwd}`,
      this.model.epicId ? `Filter: epic ${this.model.epicId}` : "Filter: all workers",
      `Summary: total=${summary.total} active=${summary.active} held=${summary.held} landed=${summary.landed} failed=${summary.failed} attention=${summary.attention} cleaned=${summary.cleaned}`,
      "",
    ];
    const footer = this.theme.fg(
      "dim",
      "↑/↓ or j/k select • use the Commands line for /bw land|cancel|cleanup targets • esc/q closes",
    );

    const lines = [...headerLines, ...bodyLines, "", footer].flatMap((line) =>
      wrapTextWithAnsi(line, Math.max(1, width)).map((wrapped) => truncateToWidth(wrapped, width)),
    );

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export async function openWorkerManager(
  ctx: ExtensionCommandContext,
  model: WorkerManagerModel,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new WorkerManagerComponent(tui, theme, model, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: 110,
        maxHeight: "85%",
        margin: 1,
      },
    },
  );
}
