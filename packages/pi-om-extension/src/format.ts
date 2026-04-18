import type { ObservationEntry, SessionState, TemporalAnchor } from "./types.js";

export interface OMStatusReport {
  sessionId: string;
  stateDir: string;
  statePath: string;
  observationTokens: number;
  draftObservationTokens: number;
  stagingThreshold: number;
  stagingMessageCountThreshold: number;
  stagingToolResultTokenThreshold: number;
  publishThreshold: number;
  publishMessageCountThreshold: number;
  publishToolResultTokenThreshold: number;
  chunkMessageTokenLimit: number;
  chunkMessageLimit: number;
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
  unobservedToolResultCount: number;
  unobservedToolResultTokens: number;
  unpublishedMessages: number;
  unpublishedMessageTokens: number;
  unpublishedToolResultCount: number;
  unpublishedToolResultTokens: number;
  nextChunkMessages: number;
  nextChunkMessageTokens: number;
  nextChunkToolResultCount: number;
  nextChunkToolResultTokens: number;
  stagingReasons: string[];
  publishReasons: string[];
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
const OBSERVATION_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

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

function formatThreshold(value: number): string {
  return Number.isFinite(value) ? formatCount(value) : "disabled";
}

function formatTriggerReasons(reasons: string[]): string {
  if (reasons.length === 0) {
    return "none";
  }

  return reasons
    .map((reason) => {
      switch (reason) {
        case "messageTokens":
          return "message tokens";
        case "messageCount":
          return "message count";
        case "toolResultTokens":
          return "tool-result tokens";
        case "force":
          return "forced";
        default:
          return reason;
      }
    })
    .join(", ");
}

function formatObservationDate(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return value;
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? new Date(`${normalized}T00:00:00.000Z`)
    : new Date(normalized);

  return Number.isNaN(date.getTime()) ? value : OBSERVATION_DATE_FORMATTER.format(date);
}

function describeTemporalAnchor(anchor: TemporalAnchor): string | undefined {
  const start = anchor.referencedStart?.trim();
  const end = anchor.referencedEnd?.trim();

  if (anchor.precision === "week" && start) {
    return `week of ${start}`;
  }

  if (anchor.precision === "month" && start) {
    return `month of ${start.slice(0, 7)}`;
  }

  if (start && end && start !== end) {
    return `${anchor.precision === "approximate" ? "approx" : "range"}: ${start}..${end}`;
  }

  const point = start || end;
  if (!point) {
    return undefined;
  }

  return anchor.relation === "future" ? `target: ${point}` : `date: ${point}`;
}

export function renderTemporalAnchor(anchor: TemporalAnchor): string {
  const phrase = anchor.originalPhrase.trim();
  const summary = describeTemporalAnchor(anchor);

  if (!summary) {
    return phrase;
  }

  return `${phrase} (${summary})`;
}

function injectTemporalAnchor(line: string, anchor: TemporalAnchor): string {
  const renderedAnchor = renderTemporalAnchor(anchor);
  if (!renderedAnchor) {
    return line;
  }

  const phrase = anchor.originalPhrase.trim();
  if (!phrase) {
    return line;
  }

  if (line.includes(renderedAnchor)) {
    return line;
  }

  const phraseIndex = line.indexOf(phrase);
  if (phraseIndex >= 0) {
    return `${line.slice(0, phraseIndex)}${renderedAnchor}${line.slice(phraseIndex + phrase.length)}`;
  }

  return `${line} [time: ${renderedAnchor}]`;
}

function renderObservationEntry(entry: ObservationEntry): string {
  return (entry.temporalAnchors ?? []).reduce(
    (line, anchor) => injectTemporalAnchor(line, anchor),
    entry.line.trim(),
  );
}

export function renderObservationEntries(entries?: ObservationEntry[]): string {
  if (!entries?.length) {
    return "";
  }

  const grouped = new Map<string, string[]>();

  for (const entry of entries) {
    const date = entry.date.trim();
    const line = renderObservationEntry(entry);
    if (!date || !line) {
      continue;
    }

    const lines = grouped.get(date) ?? [];
    lines.push(line);
    grouped.set(date, lines);
  }

  return Array.from(grouped.entries())
    .map(([date, lines]) => [`Date: ${formatObservationDate(date)}`, ...lines].join("\n"))
    .join("\n\n");
}

export function renderStoredObservations(
  state: Pick<SessionState, "observations" | "observationEntries">,
): string {
  const renderedEntries = renderObservationEntries(state.observationEntries);
  if (renderedEntries) {
    return renderedEntries;
  }

  return state.observations.trim();
}

export function formatStatusReport(status: OMStatusReport): string {
  const lines = [
    `Observational memory status · ${status.sessionId}`,
    `Published observations: ${status.observationsPresent ? "yes" : "no"} · ${formatCount(status.observationTokens)} tokens`,
    `Staged draft: ${status.draftObservationsPresent ? "yes" : "no"} · ${formatCount(status.draftObservationTokens)} tokens`,
    `Staging trigger: ${formatThreshold(status.stagingThreshold)} tokens / ${formatThreshold(status.stagingMessageCountThreshold)} messages / ${formatThreshold(status.stagingToolResultTokenThreshold)} tool-result tokens · chunk ≤ ${formatThreshold(status.chunkMessageTokenLimit)} tokens / ${formatThreshold(status.chunkMessageLimit)} messages · model ${status.observationModel}`,
    `Publish trigger: ${formatThreshold(status.publishThreshold)} tokens / ${formatThreshold(status.publishMessageCountThreshold)} messages / ${formatThreshold(status.publishToolResultTokenThreshold)} tool-result tokens`,
    `Reflection trigger: ${formatCount(status.reflectionThreshold)} staged observation tokens · model ${status.reflectionModel}`,
    `Unobserved window: ${formatCount(status.unobservedMessages)} messages · ${formatCount(status.unobservedMessageTokens)} tokens · ${formatCount(status.unobservedToolResultCount)} tool results / ${formatCount(status.unobservedToolResultTokens)} tokens · cursor ${status.cursorModeForCurrentWindow} · triggers ${formatTriggerReasons(status.stagingReasons)}`,
    `Next chunk: ${formatCount(status.nextChunkMessages)} messages · ${formatCount(status.nextChunkMessageTokens)} tokens · ${formatCount(status.nextChunkToolResultCount)} tool results / ${formatCount(status.nextChunkToolResultTokens)} tokens`,
    `Unpublished draft: ${formatCount(status.unpublishedMessages)} messages · ${formatCount(status.unpublishedMessageTokens)} tokens · ${formatCount(status.unpublishedToolResultCount)} tool results / ${formatCount(status.unpublishedToolResultTokens)} tokens · cursor ${status.unpublishedCursorModeForCurrentWindow} · triggers ${formatTriggerReasons(status.publishReasons)}`,
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
  const observations = renderStoredObservations(state);

  if (!observations) {
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

  lines.push("", "Observations:", observations);

  return lines.join("\n");
}
