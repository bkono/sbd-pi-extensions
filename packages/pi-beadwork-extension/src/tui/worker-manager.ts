import path from "node:path";
import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { summarizeWorkers } from "../registry.js";
import {
  type ActivationState,
  isSuccessfulTerminalWorker,
  isWorktreeWorker,
  type SessionState,
  type WorkerRuntime,
} from "../types.js";
import { inspectWorker, type WorkerInspection } from "../worker-diagnostics.js";
import {
  joinColumns,
  kv,
  normalizeSurfaceLines,
  renderSurface,
  sectionTitle,
  selectionMarker,
  styledAccent,
  styledDim,
  styledLabel,
  styledWarning,
  workerStatusStyle,
} from "./common.js";

/** Fallback theme that returns text unchanged */
const passthroughTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

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
  verified: 7,
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
  return action.enabled ? "ready" : "blocked";
}

export function buildWorkerFooterHint(entry?: WorkerManagerEntry): string {
  if (!entry) {
    return "↑/↓ select • esc close";
  }
  return [
    "↑/↓ select",
    `l land ${formatActionState(entry.actions.land)}`,
    `c cancel ${formatActionState(entry.actions.cancel)}`,
    `u cleanup ${formatActionState(entry.actions.cleanup)}`,
  ].join(" • ");
}
function formatTmuxTarget(worker: WorkerRuntime): string {
  return `${worker.tmuxSession}:${worker.tmuxWindow}.${worker.tmuxPane}`;
}
function clamp(text: string, width: number): string {
  return truncateToWidth(text, Math.max(14, width), "…");
}
function formatWorkerListEntry(
  theme: Theme,
  entry: WorkerManagerEntry,
  selected: boolean,
  width: number,
): string[] {
  const marker = selectionMarker(theme, selected);
  return [
    `${marker} ${styledLabel(theme, entry.worker.ticketId)} · ${workerStatusStyle(theme, entry.worker.status)}`,
    `  ${clamp(entry.worker.ticketTitle, Math.max(18, width - 4))}`,
  ];
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

function resolveVisibleWindow(
  total: number,
  selectedIndex: number,
  maxVisible: number,
): {
  start: number;
  end: number;
  hiddenBefore: number;
  hiddenAfter: number;
} {
  if (total <= maxVisible) {
    return { start: 0, end: total, hiddenBefore: 0, hiddenAfter: 0 };
  }

  const half = Math.floor(maxVisible / 2);
  const start = Math.max(0, Math.min(selectedIndex - half, total - maxVisible));
  const end = Math.min(total, start + maxVisible);
  return {
    start,
    end,
    hiddenBefore: start,
    hiddenAfter: total - end,
  };
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

  if (isSuccessfulTerminalWorker(worker) || inspection.landing.state === "verified") {
    land.reason = worker.status === "verified" ? "already verified" : "already landed";
  } else if (worker.landingRequestedAt && !worker.landingVerifiedAt) {
    land.reason = "landing already queued";
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
  } else if (isWorktreeWorker(worker) && worker.cleanupPolicy !== "keep") {
    cleanup.reason = `cleanup policy is ${worker.cleanupPolicy}`;
  } else if (
    !worker.landingVerifiedAt &&
    worker.status !== "landed" &&
    worker.status !== "verified"
  ) {
    cleanup.reason = "landing must be verified or marked landed first";
  } else {
    cleanup.enabled = true;
    cleanup.reason = isWorktreeWorker(worker)
      ? "remove retained worktree/runtime artifacts"
      : "remove retained runtime artifacts";
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

function buildGroupSummaryLines(
  theme: Theme,
  groups: WorkerManagerGroup[],
  selected?: WorkerManagerEntry,
): string[] {
  const selectedGroupId = selected
    ? groups.find((group) =>
        group.workers.some((entry) => entry.worker.workerId === selected.worker.workerId),
      )?.id
    : undefined;
  return [
    sectionTitle(theme, "Groups"),
    ...groups.flatMap((group) => {
      const marker = selectionMarker(theme, group.id === selectedGroupId);
      const label =
        group.kind === "epic" && group.label.includes("current scope")
          ? styledAccent(theme, group.label)
          : group.label;
      return [
        `${marker} ${label}`,
        `  ${group.summary.total} total · ${group.summary.active > 0 ? styledAccent(theme, `${group.summary.active} active`) : styledDim(theme, "0 active")} · ${group.summary.successfulTerminal > 0 ? styledAccent(theme, `${group.summary.successfulTerminal} done`) : styledDim(theme, "0 done")} · ${group.attention > 0 ? styledWarning(theme, `${group.attention} attention`) : styledDim(theme, "0 attention")}`,
        "",
      ];
    }),
  ];
}
function buildSelectedGroupLines(
  theme: Theme,
  groups: WorkerManagerGroup[],
  selected: WorkerManagerEntry | undefined,
  width: number,
): string[] {
  const selectedGroup = selected
    ? groups.find((group) =>
        group.workers.some((entry) => entry.worker.workerId === selected.worker.workerId),
      )
    : groups[0];
  if (!selectedGroup) {
    return [sectionTitle(theme, "Workers"), styledDim(theme, "No worker selected.")];
  }
  const selectedIndex = selected
    ? selectedGroup.workers.findIndex((entry) => entry.worker.workerId === selected.worker.workerId)
    : 0;
  const window = resolveVisibleWindow(selectedGroup.workers.length, Math.max(0, selectedIndex), 5);
  const lines = [sectionTitle(theme, "Workers"), selectedGroup.label, ""];
  if (window.hiddenBefore > 0) {
    lines.push(
      `↑ ${window.hiddenBefore} earlier worker${window.hiddenBefore === 1 ? "" : "s"}`,
      "",
    );
  }
  for (const [index, entry] of selectedGroup.workers.slice(window.start, window.end).entries()) {
    const absoluteIndex = window.start + index;
    lines.push(...formatWorkerListEntry(theme, entry, absoluteIndex === selectedIndex, width), "");
  }
  if (window.hiddenAfter > 0) {
    lines.push(`↓ ${window.hiddenAfter} later worker${window.hiddenAfter === 1 ? "" : "s"}`);
  }
  return lines;
}

export function buildWorkerDetailLines(
  theme: Theme,
  entry: WorkerManagerEntry,
  width = 40,
): string[] {
  const { worker, inspection } = entry;
  return [
    sectionTitle(theme, "Selected worker"),
    `${styledLabel(theme, worker.ticketId)} · ${workerStatusStyle(theme, worker.status)} · ticket ${worker.ticketStatus ?? "unknown"}`,
    clamp(worker.ticketTitle, width),
    "",
    sectionTitle(theme, "Checks"),
    kv(theme, "Validation", inspection.validation.summary),
    kv(theme, "Review", inspection.review.summary),
    kv(theme, "Landing", inspection.landing.summary),
    kv(theme, "Next", inspection.followUp.action),
    "",
    sectionTitle(theme, "Refs"),
    kv(theme, "tmux", clamp(formatTmuxTarget(worker), width - 5)),
    kv(theme, "log", path.basename(worker.logFile) || worker.logFile),
    isWorktreeWorker(worker)
      ? kv(theme, "worktree", path.basename(worker.worktreePath) || worker.worktreePath)
      : kv(theme, "checkout", path.basename(worker.checkoutPath) || worker.checkoutPath),
  ];
}

export function buildWorkerManagerPanelLines(input: {
  workers: WorkerRuntime[];
  state: SessionState;
  selectedWorkerId?: string;
  maxWorkersPerGroup?: number;
  width?: number;
  theme?: Theme;
}): string[] {
  const theme = input.theme ?? passthroughTheme;
  const groups = groupWorkersForManager({ workers: input.workers, state: input.state });
  if (groups.length === 0) {
    return [
      styledDim(theme, "No beadwork workers are currently tracked."),
      styledDim(
        theme,
        "Use the Issues tab to delegate work or run an epic to launch bounded workers.",
      ),
    ];
  }
  const selected = selectDefaultWorker(groups, input.selectedWorkerId);
  const width = input.width ?? 100;
  const singleColumn = width < 92;
  const leftWidth = singleColumn ? width : Math.max(34, Math.floor(width * 0.44));
  const rightWidth = singleColumn ? width : Math.max(28, width - leftWidth - 2);
  const groupLines = [
    ...buildGroupSummaryLines(theme, groups, selected),
    "",
    ...buildSelectedGroupLines(theme, groups, selected, leftWidth),
  ];
  const detailLines = selected
    ? buildWorkerDetailLines(theme, selected, rightWidth - 2)
    : [sectionTitle(theme, "Selected worker"), styledDim(theme, "No worker selected.")];
  if (singleColumn) {
    return normalizeSurfaceLines([...groupLines, "", ...detailLines], width);
  }
  return joinColumns({
    left: groupLines,
    right: detailLines,
    leftWidth,
    rightWidth,
    gap: 2,
  });
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
      width: Math.max(40, width - 4),
      theme: this.theme,
    });

    const lines = renderSurface(this.theme, width, {
      title: "Beadwork Worker Manager",
      subtitle: [
        kv(this.theme, "Repo", this.model.activation.repoRoot ?? this.model.cwd),
        this.model.epicId
          ? kv(this.theme, "Filter", `epic ${styledAccent(this.theme, this.model.epicId)}`)
          : kv(this.theme, "Filter", styledDim(this.theme, "all workers")),
        `${kv(this.theme, "Summary", `total=${summary.total}`)} active=${summary.active} held=${summary.held} done=${summary.successfulTerminal} landed=${summary.landed} verified=${summary.verified} failed=${summary.failed}`,
      ],
      sections: [{ lines: bodyLines }],
      footer: buildWorkerFooterHint(this.entries[this.selectedIndex]),
    });

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
