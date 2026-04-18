import type {
  ObservationEntry,
  TemporalAnchor,
  TemporalAnchorPrecision,
  TemporalAnchorRelation,
} from "./types.js";

const MONTH_INDEX_BY_NAME: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const WEEKDAY_INDEX_BY_NAME: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

interface DerivedTemporalAnchor {
  referencedStart?: string;
  referencedEnd?: string;
  precision: TemporalAnchorPrecision;
  relation: TemporalAnchorRelation;
}

interface TemporalMatch {
  regex: RegExp;
  infer: (match: RegExpExecArray, recordedDate: string) => DerivedTemporalAnchor | undefined;
}

const TEMPORAL_MATCHERS: TemporalMatch[] = [
  {
    regex: /\bearlier today\b/gi,
    infer: (_match, recordedDate) => ({
      referencedStart: recordedDate,
      precision: "day",
      relation: "past",
    }),
  },
  {
    regex: /\blater today\b/gi,
    infer: (_match, recordedDate) => ({
      referencedStart: recordedDate,
      precision: "day",
      relation: "future",
    }),
  },
  {
    regex: /\btomorrow\b/gi,
    infer: (_match, recordedDate) => ({
      referencedStart: addDays(recordedDate, 1),
      precision: "day",
      relation: "future",
    }),
  },
  {
    regex: /\byesterday\b/gi,
    infer: (_match, recordedDate) => ({
      referencedStart: addDays(recordedDate, -1),
      precision: "day",
      relation: "past",
    }),
  },
  {
    regex: /\b(next|last)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    infer: (match, recordedDate) => {
      const direction = match[1]?.toLowerCase();
      const weekdayName = match[2]?.toLowerCase();
      if (!direction || !weekdayName) {
        return undefined;
      }

      const weekdayIndex = WEEKDAY_INDEX_BY_NAME[weekdayName];
      if (weekdayIndex === undefined) {
        return undefined;
      }

      return {
        referencedStart: shiftToWeekday(recordedDate, weekdayIndex, direction as "next" | "last"),
        precision: "day",
        relation: direction === "next" ? "future" : "past",
      };
    },
  },
  {
    regex: /\bnext week\b/gi,
    infer: (_match, recordedDate) => {
      const referencedStart = startOfWeek(addDays(recordedDate, 7));
      return {
        referencedStart,
        referencedEnd: addDays(referencedStart, 6),
        precision: "approximate",
        relation: "future",
      };
    },
  },
  {
    regex: /\blast week\b/gi,
    infer: (_match, recordedDate) => {
      const referencedStart = startOfWeek(addDays(recordedDate, -7));
      return {
        referencedStart,
        referencedEnd: addDays(referencedStart, 6),
        precision: "week",
        relation: "past",
      };
    },
  },
  {
    regex: /\bnext month\b/gi,
    infer: (_match, recordedDate) => {
      const referencedStart = firstDayOfMonth(offsetMonth(recordedDate, 1));
      return {
        referencedStart,
        referencedEnd: lastDayOfMonth(referencedStart),
        precision: "month",
        relation: "future",
      };
    },
  },
  {
    regex: /\blast month\b/gi,
    infer: (_match, recordedDate) => {
      const referencedStart = firstDayOfMonth(offsetMonth(recordedDate, -1));
      return {
        referencedStart,
        referencedEnd: lastDayOfMonth(referencedStart),
        precision: "month",
        relation: "past",
      };
    },
  },
  {
    regex: /\btoday\b/gi,
    infer: (_match, recordedDate) => ({
      referencedStart: recordedDate,
      precision: "day",
      relation: "current",
    }),
  },
];

export function deriveObservationEntries(observations: string): ObservationEntry[] | undefined {
  const normalized = observations.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return undefined;
  }

  const entries: ObservationEntry[] = [];
  let currentDate: string | undefined;
  let sawDateHeader = false;

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (/^<\/?[a-z-]+>$/i.test(line)) {
      continue;
    }
    if (!line) {
      continue;
    }

    const dateMatch = line.match(/^Date:\s*(.+)$/i);
    if (dateMatch) {
      currentDate = parseObservationDateLabel(dateMatch[1] ?? "");
      sawDateHeader = true;
      continue;
    }

    if (!currentDate) {
      continue;
    }

    const entry = normalizeObservationEntry({ date: currentDate, line });
    if (entry) {
      entries.push(entry);
    }
  }

  return sawDateHeader && entries.length > 0 ? entries : undefined;
}

export function normalizeObservationEntries(
  entries?: ObservationEntry[],
): ObservationEntry[] | undefined {
  const normalized = entries
    ?.map(normalizeObservationEntry)
    .filter((entry): entry is ObservationEntry => !!entry);

  return normalized?.length ? normalized : undefined;
}

export function normalizeObservationEntry(entry: ObservationEntry): ObservationEntry | undefined {
  const parsedDate = parseObservationDateLabel(entry.date);
  const date = (parsedDate ?? entry.date).trim();
  const line = entry.line.replace(/\r\n/g, "\n").trim();
  if (!date || !line) {
    return undefined;
  }

  const existingAnchors = normalizeTemporalAnchors(entry.temporalAnchors);
  const inferredAnchors = parsedDate
    ? inferTemporalAnchors(line, buildRecordedAt(parsedDate, line))
    : undefined;
  const temporalAnchors = mergeTemporalAnchors(existingAnchors, inferredAnchors);

  return {
    date,
    line,
    temporalAnchors,
  };
}

export function inferTemporalAnchors(
  line: string,
  recordedAt: string,
): TemporalAnchor[] | undefined {
  const recordedDate = recordedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recordedDate)) {
    return undefined;
  }

  const matches: Array<{ start: number; anchor: TemporalAnchor }> = [];
  const occupiedRanges: Array<{ start: number; end: number }> = [];

  for (const matcher of TEMPORAL_MATCHERS) {
    matcher.regex.lastIndex = 0;

    let match = matcher.regex.exec(line);
    while (match) {
      const start = match.index;
      const end = start + match[0].length;
      if (occupiedRanges.some((range) => start < range.end && range.start < end)) {
        match = matcher.regex.exec(line);
        continue;
      }
      const originalPhrase = line.slice(start, end);
      const explicitAnchor = parseExplicitAnchor(line.slice(end), recordedDate, matcher, match);
      const inferredAnchor = explicitAnchor ?? matcher.infer(match, recordedDate);
      if (inferredAnchor) {
        occupiedRanges.push({ start, end });
        matches.push({
          start,
          anchor: {
            recordedAt,
            originalPhrase,
            ...inferredAnchor,
          },
        });
      }

      match = matcher.regex.exec(line);
    }
  }

  return dedupeTemporalAnchors(
    matches.sort((left, right) => left.start - right.start).map((match) => match.anchor),
  );
}

function normalizeTemporalAnchors(anchors?: TemporalAnchor[]): TemporalAnchor[] | undefined {
  const normalized = anchors
    ?.map((anchor) => normalizeTemporalAnchor(anchor))
    .filter((anchor): anchor is TemporalAnchor => !!anchor);

  return normalized?.length ? normalized : undefined;
}

function normalizeTemporalAnchor(anchor: TemporalAnchor): TemporalAnchor | undefined {
  const recordedAt = anchor.recordedAt.trim();
  const originalPhrase = anchor.originalPhrase.trim();
  if (!recordedAt || !originalPhrase) {
    return undefined;
  }

  return {
    recordedAt,
    originalPhrase,
    referencedStart: anchor.referencedStart?.trim() || undefined,
    referencedEnd: anchor.referencedEnd?.trim() || undefined,
    precision: anchor.precision,
    relation: anchor.relation,
  };
}

function mergeTemporalAnchors(
  existing?: TemporalAnchor[],
  inferred?: TemporalAnchor[],
): TemporalAnchor[] | undefined {
  if (!existing?.length) {
    return inferred?.length ? inferred : undefined;
  }

  if (!inferred?.length) {
    return existing;
  }

  const merged = [...existing];
  const seen = new Set(existing.map(anchorSignature));

  for (const anchor of inferred) {
    const signature = anchorSignature(anchor);
    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    merged.push(anchor);
  }

  return merged;
}

function anchorSignature(anchor: TemporalAnchor): string {
  return [
    anchor.recordedAt,
    anchor.originalPhrase.toLowerCase(),
    anchor.referencedStart ?? "",
    anchor.referencedEnd ?? "",
    anchor.precision,
    anchor.relation,
  ].join("|");
}

function dedupeTemporalAnchors(anchors: TemporalAnchor[]): TemporalAnchor[] | undefined {
  if (anchors.length === 0) {
    return undefined;
  }

  const deduped: TemporalAnchor[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    const signature = anchorSignature(anchor);
    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    deduped.push(anchor);
  }

  return deduped.length ? deduped : undefined;
}

function parseObservationDateLabel(label: string): string | undefined {
  const normalized = label.trim();
  if (!normalized) {
    return undefined;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  const match = normalized.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) {
    return undefined;
  }

  const monthIndex = MONTH_INDEX_BY_NAME[match[1]!.toLowerCase()];
  const day = Number.parseInt(match[2]!, 10);
  const year = Number.parseInt(match[3]!, 10);
  if (monthIndex === undefined || !Number.isInteger(day) || !Number.isInteger(year)) {
    return undefined;
  }

  return createIsoDate(year, monthIndex, day);
}

function buildRecordedAt(date: string, line: string): string {
  const timeMatch = line.match(/\((\d{1,2}):(\d{2})\)/);
  const hours = timeMatch?.[1]?.padStart(2, "0") ?? "00";
  const minutes = timeMatch?.[2] ?? "00";
  return `${date}T${hours}:${minutes}:00.000Z`;
}

function parseExplicitAnchor(
  remainder: string,
  recordedDate: string,
  matcher: TemporalMatch,
  match: RegExpExecArray,
): DerivedTemporalAnchor | undefined {
  const targetMatch = remainder.match(/^\s*\(target:\s*(\d{4}-\d{2}-\d{2})\)/i);
  if (targetMatch?.[1]) {
    return {
      referencedStart: targetMatch[1],
      precision: "day",
      relation: relationFromExplicitAnchor(targetMatch[1], undefined, recordedDate, matcher, match),
    };
  }

  const dateMatch = remainder.match(/^\s*\(date:\s*(\d{4}-\d{2}-\d{2})\)/i);
  if (dateMatch?.[1]) {
    return {
      referencedStart: dateMatch[1],
      precision: "day",
      relation: relationFromExplicitAnchor(dateMatch[1], undefined, recordedDate, matcher, match),
    };
  }

  const weekMatch = remainder.match(/^\s*\(week of\s*(\d{4}-\d{2}-\d{2})\)/i);
  if (weekMatch?.[1]) {
    return {
      referencedStart: weekMatch[1],
      referencedEnd: addDays(weekMatch[1], 6),
      precision: "week",
      relation: relationFromExplicitAnchor(
        weekMatch[1],
        addDays(weekMatch[1], 6),
        recordedDate,
        matcher,
        match,
      ),
    };
  }

  const monthMatch = remainder.match(/^\s*\(month of\s*(\d{4}-\d{2})(?:-\d{2})?\)/i);
  if (monthMatch?.[1]) {
    const referencedStart = `${monthMatch[1]}-01`;
    return {
      referencedStart,
      referencedEnd: lastDayOfMonth(referencedStart),
      precision: "month",
      relation: relationFromExplicitAnchor(
        referencedStart,
        lastDayOfMonth(referencedStart),
        recordedDate,
        matcher,
        match,
      ),
    };
  }

  const approxMatch = remainder.match(
    /^\s*\(approx:\s*(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})\)/i,
  );
  if (approxMatch?.[1] && approxMatch[2]) {
    return {
      referencedStart: approxMatch[1],
      referencedEnd: approxMatch[2],
      precision: "approximate",
      relation: relationFromExplicitAnchor(
        approxMatch[1],
        approxMatch[2],
        recordedDate,
        matcher,
        match,
      ),
    };
  }

  return undefined;
}

function relationFromExplicitAnchor(
  referencedStart: string,
  referencedEnd: string | undefined,
  recordedDate: string,
  matcher: TemporalMatch,
  match: RegExpExecArray,
): TemporalAnchorRelation {
  const inferred = matcher.infer(match, recordedDate);
  if (inferred?.relation === "past" || inferred?.relation === "future") {
    return inferred.relation;
  }

  if (inferred?.relation === "ongoing") {
    return "ongoing";
  }

  return compareDateRangeToRecordedAt(referencedStart, referencedEnd, recordedDate);
}

function compareDateRangeToRecordedAt(
  referencedStart: string,
  referencedEnd: string | undefined,
  recordedDate: string,
): TemporalAnchorRelation {
  if (referencedEnd && referencedEnd < recordedDate) {
    return "past";
  }

  if (referencedStart > recordedDate) {
    return "future";
  }

  if (referencedEnd && referencedEnd > recordedDate) {
    return "ongoing";
  }

  return referencedStart === recordedDate ? "current" : "past";
}

function createIsoDate(year: number, monthIndex: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return toIsoDate(date);
}

function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return toIsoDate(date);
}

function startOfWeek(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  const dayOffset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayOffset);
  return toIsoDate(date);
}

function offsetMonth(value: string, amount: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + amount, 1);
  return toIsoDate(date);
}

function firstDayOfMonth(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(1);
  return toIsoDate(date);
}

function lastDayOfMonth(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return toIsoDate(date);
}

function shiftToWeekday(
  recordedDate: string,
  weekdayIndex: number,
  direction: "next" | "last",
): string {
  const date = new Date(`${recordedDate}T00:00:00.000Z`);
  const currentWeekday = date.getUTCDay();
  let delta = weekdayIndex - currentWeekday;

  if (direction === "next") {
    if (delta <= 0) {
      delta += 7;
    }
  } else if (delta >= 0) {
    delta -= 7;
  }

  date.setUTCDate(date.getUTCDate() + delta);
  return toIsoDate(date);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
