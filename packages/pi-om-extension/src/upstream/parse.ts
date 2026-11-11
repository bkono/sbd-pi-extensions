/**
 * Vendored from @mastra/memory@1.41.0 (Apache-2.0): observer-agent.ts (output parsing and
 * context optimization) and reflector-agent.ts (output parsing, compression validation).
 * Copyright Mastra AI, Inc. Licensed under the Apache License, Version 2.0.
 */
// biome-ignore-all lint: verbatim upstream code
import { stripEphemeralAnchorIds } from "./anchor-ids";
import { safeSlice } from "./string-utils";

/**
 * Parsed result from XML memory section
 */
interface ParsedMemorySection {
  observations: string;
  currentTask: string;
  suggestedResponse: string;
  threadTitle: string;
}

/**
 * Parse XML tags from observer/reflector output.
 * Extracts content from <observations>, <current-task>, and <suggested-response> tags.
 */
export function parseMemorySectionXml(content: string): ParsedMemorySection {
  const result: ParsedMemorySection = {
    observations: "",
    currentTask: "",
    suggestedResponse: "",
    threadTitle: "",
  };

  // Extract <observations> content (supports multiple blocks)
  // Opening tags must be at the start of a line (with optional leading whitespace) to avoid
  // capturing inline mentions like "User discussed <observations> tags". A section closes either
  // at the end of its own opening line (`<observations>X</observations>`) or at a line that
  // starts with the closing tag, so a content line that mentions or ends with a closing tag
  // does not truncate a multi-line section.
  const observationsRegex =
    /^[ \t]*<observations>(?:([^\r\n]*?)<\/observations>[ \t]*$|([\s\S]*?)^[ \t]*<\/observations>)/gim;
  const observationsMatches = [...content.matchAll(observationsRegex)];
  if (observationsMatches.length > 0) {
    result.observations = observationsMatches
      .map((m) => (m[1] ?? m[2])?.trim() ?? "")
      .filter(Boolean)
      .join("\n");
  } else {
    // Fallback: if no XML tags, extract list items from raw content
    // This handles cases where the LLM doesn't follow the XML format exactly
    result.observations = extractListItemsOnly(content);
  }

  // Extract <current-task> content (first match only)
  // Same opening/closing rules as <observations> above
  const currentTaskMatch = content.match(
    /^[ \t]*<current-task>(?:([^\r\n]*?)<\/current-task>[ \t]*$|([\s\S]*?)^[ \t]*<\/current-task>)/im,
  );
  const currentTask = currentTaskMatch?.[1] ?? currentTaskMatch?.[2];
  if (currentTask) {
    result.currentTask = currentTask.trim();
  }

  // Extract <suggested-response> content (first match only)
  // Same opening/closing rules as <observations> above
  const suggestedResponseMatch = content.match(
    /^[ \t]*<suggested-response>(?:([^\r\n]*?)<\/suggested-response>[ \t]*$|([\s\S]*?)^[ \t]*<\/suggested-response>)/im,
  );
  const suggestedResponse = suggestedResponseMatch?.[1] ?? suggestedResponseMatch?.[2];
  if (suggestedResponse) {
    result.suggestedResponse = suggestedResponse.trim();
  }

  // Extract <thread-title> content (first match only)
  // Opening tag must be at the start of a line; closing tag can be on the same line
  // (titles are short, so LLMs typically output them on a single line)
  const threadTitleMatch = content.match(/^[ \t]*<thread-title>([\s\S]*?)<\/thread-title>/im);
  if (threadTitleMatch?.[1]) {
    result.threadTitle = threadTitleMatch[1].trim();
  }

  return result;
}

/**
 * Fallback: Extract only list items from content when XML tags are missing.
 * Preserves nested list items (indented with spaces/tabs).
 */
function extractListItemsOnly(content: string): string {
  const lines = content.split("\n");
  const listLines: string[] = [];

  for (const line of lines) {
    // Match lines that start with list markers (-, *, or numbered)
    // Allow leading whitespace for nested items
    if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      listLines.push(line);
    }
  }

  return listLines.join("\n").trim();
}

/**
 * Maximum length (in characters) for a single observation line.
 * Lines exceeding this are truncated with an ellipsis marker.
 * This guards against LLM degeneration that produces enormous single-line outputs.
 */
const MAX_OBSERVATION_LINE_CHARS = 10_000;

/**
 * Minimum trimmed line length considered by the duplicate-line degenerate
 * check. Short lines (blank lines, separators, terse bullets) legitimately
 * repeat; long identical lines almost never do.
 */
const MIN_DUPLICATE_LINE_CHARS = 24;

/**
 * Collapse a run of back-to-back identical lines to a single line when that
 * run is the line's only occurrence and is no bigger than one maximum-length
 * observation line. A faithful summary of a repetitive tool loop (e.g. 30×
 * "pnpm --filter … build → ok") produces exactly that shape at any line
 * length. Loops are left intact: a model stuck on one line runs far past the
 * size bound, and a line that keeps recurring between other lines has more
 * than one run.
 */
function collapseBoundedLineRuns(lines: string[]): string[] {
  const runs: Array<{ line: string; count: number }> = [];
  for (const line of lines) {
    const last = runs[runs.length - 1];
    if (last && last.line === line) last.count++;
    else runs.push({ line, count: 1 });
  }
  const runsPerLine = new Map<string, number>();
  for (const run of runs) runsPerLine.set(run.line, (runsPerLine.get(run.line) ?? 0) + 1);

  const result: string[] = [];
  for (const run of runs) {
    const collapse =
      runsPerLine.get(run.line) === 1 &&
      run.count * (run.line.length + 1) <= MAX_OBSERVATION_LINE_CHARS;
    for (let j = 0; j < (collapse ? 1 : run.count); j++) result.push(run.line);
  }
  return result;
}

/**
 * Truncate individual observation lines that exceed the maximum length.
 */
export function sanitizeObservationLines(observations: string): string {
  if (!observations) return observations;
  const lines = observations.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > MAX_OBSERVATION_LINE_CHARS) {
      lines[i] = safeSlice(lines[i]!, MAX_OBSERVATION_LINE_CHARS) + " … [truncated]";
      changed = true;
    }
  }
  return changed ? lines.join("\n") : observations;
}

const OBSERVATION_TIME = /^[*-]\s+(?:\S+\s+)?\((\d{1,2}):(\d{2})\s*([AaPp])?\.?(?:[Mm]\.?)?\)/;

/** Minutes since midnight for each item, or undefined when the group's times can't be ordered safely. */
function observationMinutes(items: string[][]): number[] | undefined {
  const times = items.map((item) => OBSERVATION_TIME.exec(item[0]!));
  if (times.some((t) => !t)) return undefined;
  const matches = times as RegExpExecArray[];
  const marked = matches.filter((m) => m[3]).length;
  if (marked > 0 && marked < matches.length) return undefined;
  if (marked === matches.length) {
    return matches.map(
      (m) => (Number(m[1]) % 12) * 60 + (/p/i.test(m[3]!) ? 720 : 0) + Number(m[2]),
    );
  }
  // Without AM/PM, "13:35" or "09:15" are 24-hour, "1:35" is 12-hour, and "10:30" could be either.
  const hours = matches.map((m) => m[1]!);
  const twelveHour = hours.some((h) => /^[1-9]$/.test(h));
  const twentyFourHour = hours.some((h) => /^(0\d|1[3-9]|2\d)$/.test(h));
  if (twelveHour && (twentyFourHour || new Set(hours).size > 1)) return undefined;
  return matches.map((m) => Number(m[1]) * 60 + Number(m[2]));
}

/**
 * Put the top-level observations of each "Date:" group in time order, keeping indented
 * sub-items with their parent. The Observer writes a time on every observation but tends
 * to list a user's message ahead of the earlier events it follows, which can make a
 * superseded state read as the latest one. Groups are left as written when any
 * observation has no time or the times are ambiguous.
 */
export function sortObservationsByTime(observations: string): string {
  if (!observations) return observations;
  const output: string[] = [];
  let group:
    | { header: string[]; items: string[][]; trailing: string[]; sortable: boolean }
    | undefined;

  const flush = () => {
    if (!group) return;
    const minutes =
      group.sortable && group.items.length > 1 ? observationMinutes(group.items) : undefined;
    const items = minutes
      ? group.items
          .map((item, i) => ({ item, minute: minutes[i]! }))
          .sort((a, b) => a.minute - b.minute)
          .map((x) => x.item)
      : group.items;
    output.push(...group.header, ...items.flat(), ...group.trailing);
    group = undefined;
  };

  for (const line of observations.split("\n")) {
    if (/^\s*Date:\s/.test(line)) {
      flush();
      group = { header: [line], items: [], trailing: [], sortable: true };
    } else if (!group) {
      output.push(line);
    } else if (/^[*-]\s/.test(line)) {
      group.items.at(-1)?.push(...group.trailing);
      group.trailing = [];
      group.items.push([line]);
    } else if (group.items.length === 0) {
      group.header.push(line);
    } else if (line.trim() === "") {
      group.trailing.push(line);
    } else if (/^\s/.test(line)) {
      group.items.at(-1)!.push(...group.trailing, line);
      group.trailing = [];
    } else {
      group.sortable = false;
      group.items.at(-1)!.push(...group.trailing, line);
      group.trailing = [];
    }
  }
  flush();
  return output.join("\n");
}

/**
 * Detect degenerate repetition in observer/reflector output.
 * Returns true if the text contains suspicious levels of repeated content,
 * which indicates an LLM repeat-penalty bug (e.g., Gemini Flash looping).
 *
 * Strategy: sample sequential chunks of the text and check if a high
 * proportion are near-identical to previous chunks.
 */
interface DegenerateAnalysis {
  windowText: string;
  totalWindows: number;
  duplicateWindows: number;
  topWindow: string;
  topWindowCount: number;
  totalCountedLines: number;
  duplicateLines: number;
  windowFired: boolean;
  lineFired: boolean;
  shortLineFired: boolean;
}

function analyzeDegenerateRepetition(text: string): DegenerateAnalysis {
  const lines = collapseBoundedLineRuns(text.split("\n"));

  // Strategy 1: Check for repeated long substrings by sampling fixed-size windows.
  // If the same ~200-char window appears many times, it's degenerate.
  // Short lines are ignored: faithful summaries of repetitive tool output
  // (e.g. many "→ ok" lines) are legitimately repetitive and would otherwise
  // produce colliding windows. Loops of substantial lines are still sampled.
  // Truncated giant lines are skipped too: they are already bounded, and one
  // periodic line (e.g. a progress bar) would otherwise fill the sample alone.
  const windowText = lines
    .filter(
      (line) =>
        line.trim().length >= MIN_DUPLICATE_LINE_CHARS && line.length <= MAX_OBSERVATION_LINE_CHARS,
    )
    .join("\n");
  const windowSize = 200;
  const step = Math.max(1, Math.floor(windowText.length / 50)); // sample ~50 windows
  const seen = new Map<string, number>();
  let duplicateWindows = 0;
  let totalWindows = 0;
  let topWindow = "";
  let topWindowCount = 0;
  for (let i = 0; i + windowSize <= windowText.length; i += step) {
    const window = windowText.slice(i, i + windowSize);
    totalWindows++;
    const count = (seen.get(window) ?? 0) + 1;
    seen.set(window, count);
    if (count > 1) duplicateWindows++;
    if (count > topWindowCount) {
      topWindowCount = count;
      topWindow = window;
    }
  }
  // If more than 40% of sampled windows are duplicates, it's degenerate
  const windowFired =
    windowText.length >= 2000 && totalWindows > 5 && duplicateWindows / totalWindows > 0.4;

  // Strategy 2: Exact-duplicate line ratio. The window sampling above has an
  // aliasing blind spot: for a repeating block with period P chars, sampled
  // windows only collide when two sample positions are congruent mod P, so a
  // long-period multi-line loop (e.g. a 21-line block repeated 62 times,
  // observed in production) can dominate the output while producing zero
  // duplicate windows. Observations are line-oriented, so count exact
  // duplicates among substantial lines instead — legitimate output almost
  // never repeats long identical lines.
  const seenLines = new Map<string, number>();
  let duplicateLines = 0;
  let totalCountedLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < MIN_DUPLICATE_LINE_CHARS) continue;
    totalCountedLines++;
    const count = (seenLines.get(trimmed) ?? 0) + 1;
    seenLines.set(trimmed, count);
    if (count > 1) duplicateLines++;
  }
  const lineFired = totalCountedLines >= 20 && duplicateLines / totalCountedLines > 0.5;

  // Strategy 3: short lines are exempt above only while their repetition is
  // bounded. Short lines that occur more than once within a run share one
  // budget: when all their occurrences in that run add up to more than one maximum-size
  // observation line, it is a loop, not a faithful summary. A shared budget
  // keeps a loop of many distinct short lines from multiplying the bound.
  // Grouping ignores indentation but the budget counts it, plus one newline
  // per occurrence. A line that occurs once never counts, however padded.
  // Format scaffolding (lines that are only an XML tag, and `Date:` headers)
  // is required once per thread block, so it grows with the number of threads
  // rather than with any loop and is left out of the budget.
  // The budget applies to each contiguous run of short lines and resets at
  // every substantive line: a looping model emits short lines back to back,
  // while short status lines that legitimately recur across groups are
  // separated by substantive observations.
  let shortLineFired = false;
  let shortLineCounts = new Map<string, { count: number; chars: number }>();
  const runExceedsBudget = () => {
    let repeatedShortChars = 0;
    for (const { count, chars } of shortLineCounts.values()) {
      if (count > 1) repeatedShortChars += chars;
    }
    // The trailing newline of the last occurrence is not part of the output.
    return repeatedShortChars - 1 > MAX_OBSERVATION_LINE_CHARS;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length >= MIN_DUPLICATE_LINE_CHARS) {
      if (runExceedsBudget()) shortLineFired = true;
      shortLineCounts = new Map();
      continue;
    }
    if (/^<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?>$/.test(trimmed) || trimmed.startsWith("Date:")) continue;
    const entry = shortLineCounts.get(trimmed) ?? { count: 0, chars: 0 };
    entry.count++;
    entry.chars += line.length + 1;
    shortLineCounts.set(trimmed, entry);
  }
  if (runExceedsBudget()) shortLineFired = true;

  // The detector ignores anything under 2,000 characters; keep the fired flags
  // consistent with that so diagnostics never name a strategy it would not use.
  const eligible = text.length >= 2000;
  return {
    windowText,
    totalWindows,
    duplicateWindows,
    topWindow,
    topWindowCount,
    totalCountedLines,
    duplicateLines,
    windowFired: eligible && windowFired,
    lineFired: eligible && lineFired,
    shortLineFired: eligible && shortLineFired,
  };
}

export function detectDegenerateRepetition(text: string): boolean {
  if (!text || text.length < 2000) return false;
  const analysis = analyzeDegenerateRepetition(text);
  return analysis.windowFired || analysis.lineFired || analysis.shortLineFired;
}

/**
 * Build a single-line diagnostic description of output flagged by
 * {@link detectDegenerateRepetition}. Used when logging or surfacing a
 * degenerate-output failure so the discarded model output can be inspected —
 * without it there is no way to tell a real repetition loop apart from a
 * detector false-positive on legitimately repetitive content.
 *
 * Runs the detector's analysis on the same sanitized text the detector judges
 * (giant lines truncated), so `strategy=` names what triggered the rejection.
 * For a short-line loop the window and line ratios read n/a or low, because
 * short lines are excluded from both. `length` and `longestLine` describe the
 * raw output. Snippets are JSON-escaped so the result stays on one line.
 */
export function describeDegenerateOutput(text: string, snippetChars = 400): string {
  const a = analyzeDegenerateRepetition(sanitizeObservationLines(text));
  let longestLine = 0;
  for (const line of text.split("\n")) {
    if (line.length > longestLine) longestLine = line.length;
  }
  const fired =
    [
      a.windowFired && "window",
      a.lineFired && "duplicateLines",
      a.shortLineFired && "shortLineLoop",
    ]
      .filter(Boolean)
      .join("+") || "none";
  const duplicateRatio =
    a.totalWindows > 0 ? (a.duplicateWindows / a.totalWindows).toFixed(2) : "n/a";
  const duplicateLineRatio =
    a.totalCountedLines > 0 ? (a.duplicateLines / a.totalCountedLines).toFixed(2) : "n/a";
  const parts = [
    `strategy=${fired}`,
    `length=${text.length}`,
    `windowTextLength=${a.windowText.length}`,
    `sampledWindows=${a.totalWindows}`,
    `duplicateRatio=${duplicateRatio}`,
    `duplicateLineRatio=${duplicateLineRatio}`,
    `countedLines=${a.totalCountedLines}`,
    `longestLine=${longestLine}`,
    `topWindowCount=${a.topWindowCount}`,
  ];
  if (a.topWindowCount > 1) parts.push(`topWindow=${JSON.stringify(a.topWindow)}`);
  parts.push(`head=${JSON.stringify(text.slice(0, snippetChars))}`);
  if (text.length > snippetChars * 2)
    parts.push(`tail=${JSON.stringify(text.slice(-snippetChars))}`);
  return parts.join(" ");
}

/**
 * Check if observations contain a Current Task section.
 * Supports both XML format and legacy markdown format.
 */
export function hasCurrentTaskSection(observations: string): boolean {
  // Check for XML format first
  if (/<current-task>/i.test(observations)) {
    return true;
  }

  // Legacy markdown patterns
  const currentTaskPatterns = [
    /\*\*Current Task:?\*\*/i,
    /^Current Task:/im,
    /\*\*Current Task\*\*:/i,
    /## Current Task/i,
  ];

  return currentTaskPatterns.some((pattern) => pattern.test(observations));
}

/**
 * Extract the Current Task content from observations.
 */
export function extractCurrentTask(observations: string): string | null {
  const openTag = "<current-task>";
  const closeTag = "</current-task>";
  const startIdx = observations.toLowerCase().indexOf(openTag);
  if (startIdx === -1) return null;
  const contentStart = startIdx + openTag.length;
  const endIdx = observations.toLowerCase().indexOf(closeTag, contentStart);
  if (endIdx === -1) return null;
  const content = observations.slice(contentStart, endIdx).trim();
  return content || null;
}

/**
 * Optimize observations for token efficiency before presenting to the Actor.
 *
 * This removes:
 * - Non-critical emojis (🟡 and 🟢, keeping only 🔴)
 * - Semantic tags [label, label]
 * - Arrow indicators (->)
 * - Extra whitespace
 *
 * The full format is preserved in storage for analysis.
 */
export function optimizeObservationsForContext(observations: string): string {
  let optimized = stripEphemeralAnchorIds(observations);

  // Remove 🟡 and 🟢 emojis (keep 🔴 for critical items)
  optimized = optimized.replace(/🟡\s*/g, "");
  optimized = optimized.replace(/🟢\s*/g, "");

  // Remove semantic tags like [label, label] but keep collapsed markers like [72 items collapsed - ID: b1fa]
  // and markdown link text like [label](url) — the trailing `(?!\()` lookahead keeps the label so the
  // link survives intact instead of collapsing to a bare, unlabelled URL.
  optimized = optimized.replace(/\[(?![\d\s]*items collapsed)[^\]]+\](?!\()/g, "");

  // Remove arrow indicators
  optimized = optimized.replace(/\s*->\s*/g, " ");

  // Clean up multiple spaces
  optimized = optimized.replace(/  +/g, " ");

  // Clean up multiple newlines
  optimized = optimized.replace(/\n{3,}/g, "\n\n");

  return optimized.trim();
}

/**
 * Parsed result from XML reflector section
 */
interface ParsedReflectorSection {
  observations: string;
  currentTask: string;
  suggestedResponse: string;
}

/**
 * Parse XML tags from reflector output.
 * Extracts content from <observations>, <current-task>, and <suggested-response> tags.
 */
export function parseReflectorSectionXml(content: string): ParsedReflectorSection {
  const result: ParsedReflectorSection = {
    observations: "",
    currentTask: "",
    suggestedResponse: "",
  };

  // Extract <observations> content (supports multiple blocks)
  // Tags must be at the start of a line (with optional leading whitespace) to avoid
  // capturing inline mentions like "User discussed <observations> tags"
  const observationsRegex = /^[ \t]*<observations>([\s\S]*?)^[ \t]*<\/observations>/gim;
  const observationsMatches = [...content.matchAll(observationsRegex)];
  if (observationsMatches.length > 0) {
    result.observations = observationsMatches
      .map((m) => m[1]?.trim() ?? "")
      .filter(Boolean)
      .join("\n");
  } else {
    // Fallback: if no XML tags, try extracting list items first, then fall back to full content
    const listItems = extractReflectorListItems(content);
    result.observations = listItems || content.trim();
  }

  // Extract <current-task> content (first match only)
  const currentTaskMatch = content.match(/<current-task>([\s\S]*?)<\/current-task>/i);
  if (currentTaskMatch?.[1]) {
    result.currentTask = currentTaskMatch[1].trim();
  }

  // Extract <suggested-response> content (first match only)
  const suggestedResponseMatch = content.match(
    /<suggested-response>([\s\S]*?)<\/suggested-response>/i,
  );
  if (suggestedResponseMatch?.[1]) {
    result.suggestedResponse = suggestedResponseMatch[1].trim();
  }

  return result;
}

/**
 * Fallback: Extract only list items from content when XML tags are missing.
 */
function extractReflectorListItems(content: string): string {
  const lines = content.split("\n");
  const listLines: string[] = [];

  for (const line of lines) {
    // Match lines that start with list markers (-, *, or numbered)
    if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      listLines.push(line);
    }
  }

  return listLines.join("\n").trim();
}

/**
 * Validate that reflection actually compressed the observations below the target threshold
 *
 * @param reflectedTokens - Token count of reflected observations
 * @param targetThreshold - Target token count to compress below (the reflection threshold)
 * @returns true if compression was successful (reflected tokens are below target)
 */
export function validateCompression(reflectedTokens: number, targetThreshold: number): boolean {
  // Reflection should be below the target threshold
  return reflectedTokens < targetThreshold;
}
