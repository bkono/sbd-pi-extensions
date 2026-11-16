// Minimal structured logger. Tests capture output with `captureLogs`.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  level: LogLevel;
  msg: string;
  fields: Record<string, unknown>;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: LogLevel = "warn";
let sink: ((record: LogRecord) => void) | null = null;

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < LEVELS[threshold]) return;
  const record = { level, msg, fields };
  if (sink) sink(record);
  else console.error(JSON.stringify(record));
}

export function captureLogs<T>(fn: () => T): { result: T; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const previous = sink;
  const previousThreshold = threshold;
  sink = (r) => records.push(r);
  threshold = "debug";
  try {
    return { result: fn(), records };
  } finally {
    sink = previous;
    threshold = previousThreshold;
  }
}
