import type { SessionState } from "./types.js";

export interface OMStatusReport {
  sessionId: string;
  stateDir: string;
  statePath: string;
  observationTokens: number;
  draftObservationTokens: number;
  stagingThreshold: number;
  publishThreshold: number;
  observationModel: string;
  reflectionThreshold: number;
  reflectionModel: string;
  observationsPresent: boolean;
  draftObservationsPresent: boolean;
  lastObservedEntryId: string | null;
  lastObservedTimestamp: string | null;
  draftLastObservedEntryId: string | null;
  draftLastObservedTimestamp: string | null;
  cursorModeForCurrentWindow: string;
  unpublishedCursorModeForCurrentWindow: string;
  unobservedMessages: number;
  unobservedMessageTokens: number;
  unpublishedMessages: number;
  unpublishedMessageTokens: number;
  lastCycleAt: string | null;
  lastCycleReason: string | null;
  lastCursorMode: string | null;
  observeTriggered: boolean | null;
  publishTriggered: boolean | null;
  reflectTriggered: boolean | null;
  tailEntriesBeforePrune: number | null;
  tailTokensBeforePrune: number | null;
  tailEntriesAfterPrune: number | null;
  tailTokensAfterPrune: number | null;
  prunedEntriesCount: number | null;
  currentTask: string | null;
  suggestedResponse: string | null;
  updatedAt: string;
}

export const OM_COMMAND_USAGE = [
  "Usage: /om [status|observations]",
  "- /om status        Show human-readable OM status for the current session.",
  "- /om observations  Show stored observations for the current session.",
].join("\n");

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

function formatCount(value: number): string {
  return NUMBER_FORMATTER.format(value);
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "never";
  }

  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function formatOptionalBoolean(value: boolean | null): string {
  if (value === null) {
    return "n/a";
  }

  return value ? "yes" : "no";
}

function formatOptionalCount(value: number | null): string {
  return value === null ? "n/a" : formatCount(value);
}

export function formatStatusReport(status: OMStatusReport): string {
  const lines = [
    `Observational memory status · ${status.sessionId}`,
    `Published observations: ${status.observationsPresent ? "yes" : "no"} · ${formatCount(status.observationTokens)} tokens`,
    `Staged draft: ${status.draftObservationsPresent ? "yes" : "no"} · ${formatCount(status.draftObservationTokens)} tokens`,
    `Staging trigger: ${formatCount(status.stagingThreshold)} unobserved message tokens · model ${status.observationModel}`,
    `Publish trigger: ${formatCount(status.publishThreshold)} staged-but-unpublished message tokens`,
    `Reflection trigger: ${formatCount(status.reflectionThreshold)} staged observation tokens · model ${status.reflectionModel}`,
    `Unobserved window: ${formatCount(status.unobservedMessages)} messages · ${formatCount(status.unobservedMessageTokens)} tokens · cursor ${status.cursorModeForCurrentWindow}`,
    `Unpublished draft: ${formatCount(status.unpublishedMessages)} messages · ${formatCount(status.unpublishedMessageTokens)} tokens · cursor ${status.unpublishedCursorModeForCurrentWindow}`,
    `Last cycle: ${status.lastCycleReason ?? "none"} · ${formatTimestamp(status.lastCycleAt)}`,
    `Published through: entry ${status.lastObservedEntryId ?? "none"} · ${formatTimestamp(status.lastObservedTimestamp)}`,
    `Staged through: entry ${status.draftLastObservedEntryId ?? "none"} · ${formatTimestamp(status.draftLastObservedTimestamp)}`,
    `Cycle decisions: stage ${formatOptionalBoolean(status.observeTriggered)} · publish ${formatOptionalBoolean(status.publishTriggered)} · reflect ${formatOptionalBoolean(status.reflectTriggered)}`,
  ];

  if (
    status.tailEntriesBeforePrune !== null ||
    status.tailEntriesAfterPrune !== null ||
    status.prunedEntriesCount !== null
  ) {
    lines.push(
      `Last prune: ${formatOptionalCount(status.tailEntriesBeforePrune)} → ${formatOptionalCount(status.tailEntriesAfterPrune)} messages · ${formatOptionalCount(status.prunedEntriesCount)} pruned · ${formatOptionalCount(status.tailTokensBeforePrune)} → ${formatOptionalCount(status.tailTokensAfterPrune)} tokens`,
    );
  } else {
    lines.push("Last prune: n/a");
  }

  if (status.lastCursorMode) {
    lines.push(`Last prune cursor mode: ${status.lastCursorMode}`);
  }

  lines.push(`Updated: ${formatTimestamp(status.updatedAt)}`);

  if (status.currentTask) {
    lines.push("", "Current task:", status.currentTask);
  }

  if (status.suggestedResponse) {
    lines.push("", "Suggested response:", status.suggestedResponse);
  }

  return lines.join("\n");
}

export function formatObservationsReport(state: SessionState): string {
  const lines = [`Observational memory observations · ${state.sessionId}`];

  if (!state.observations.trim()) {
    lines.push("No observations stored yet.");
    return lines.join("\n");
  }

  lines.push(
    `Stored observation tokens: ${formatCount(state.observationTokens)}`,
    `Updated: ${formatTimestamp(new Date(state.updatedAt).toISOString())}`,
  );

  if (state.currentTask) {
    lines.push("", "Current task:", state.currentTask);
  }

  if (state.suggestedResponse) {
    lines.push("", "Suggested response:", state.suggestedResponse);
  }

  lines.push("", "Observations:", state.observations.trim());

  return lines.join("\n");
}
