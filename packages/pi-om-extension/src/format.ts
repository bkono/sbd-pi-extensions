import type { SessionState } from "./types.js";

export interface OMStatusReport {
  sessionId: string;
  stateDir: string;
  statePath: string;
  observationTokens: number;
  observationThreshold: number;
  observationModel: string;
  reflectionThreshold: number;
  reflectionModel: string;
  observationsPresent: boolean;
  lastObservedEntryId: string | null;
  lastObservedTimestamp: string | null;
  cursorModeForCurrentWindow: string;
  unobservedMessages: number;
  unobservedMessageTokens: number;
  lastCycleAt: string | null;
  lastCycleReason: string | null;
  lastCursorMode: string | null;
  observeTriggered: boolean | null;
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
    `Stored observations: ${status.observationsPresent ? "yes" : "no"} · ${formatCount(status.observationTokens)} tokens`,
    `Observation trigger: ${formatCount(status.observationThreshold)} tokens · model ${status.observationModel}`,
    `Reflection trigger: ${formatCount(status.reflectionThreshold)} observation tokens · model ${status.reflectionModel}`,
    `Unobserved window: ${formatCount(status.unobservedMessages)} messages · ${formatCount(status.unobservedMessageTokens)} tokens · cursor ${status.cursorModeForCurrentWindow}`,
    `Last cycle: ${status.lastCycleReason ?? "none"} · ${formatTimestamp(status.lastCycleAt)}`,
    `Last observed: entry ${status.lastObservedEntryId ?? "none"} · ${formatTimestamp(status.lastObservedTimestamp)}`,
    `Cycle decisions: observe ${formatOptionalBoolean(status.observeTriggered)} · reflect ${formatOptionalBoolean(status.reflectTriggered)}`,
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
