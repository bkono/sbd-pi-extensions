import path from "node:path";

/**
 * Lexical path identity for advisory intent. No glob, no brace expansion,
 * no symlink resolution, no filesystem lock. `*` is a literal segment.
 */
export function normalizeIntentPath(input: string, cwd: string): string {
  const raw = input.trim().replaceAll("\\", "/");
  if (raw.length === 0) return "";

  const cwdPosix = cwd.trim().replaceAll("\\", "/") || ".";
  let relative = raw;
  if (isAbsolutePosixish(raw)) {
    const abs = path.posix.normalize(raw);
    const cwdNorm = path.posix.normalize(cwdPosix);
    relative = path.posix.relative(cwdNorm, abs);
    if (relative === "") relative = ".";
  }

  let normalized = path.posix.normalize(relative);
  if (normalized === ".") return ".";
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function isAbsolutePosixish(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

/** Empty / `.` is the group root (overlaps every descendant). */
export function pathSegments(normalized: string): string[] {
  if (normalized === "." || normalized.length === 0) return [];
  return normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
}

/** Exact match or ancestor/descendant. Segment equality only; no globs. */
export function pathsOverlap(a: string, b: string): boolean {
  const left = pathSegments(a);
  const right = pathSegments(b);
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}
