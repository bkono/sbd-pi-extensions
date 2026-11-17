/* biome-ignore-all lint/suspicious/noExplicitAny: hashline validation exposes generic runtime type guards. */
/**
 * Hashline engine — hash-anchored line editing.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 * Edits are applied exactly as sent.
 */

import xxhashWasm from "xxhash-wasm";
import type { PtcLine } from "./ptc-value.js";
import { throwIfAborted } from "./runtime.js";

// ─── Types ──────────────────────────────────────────────────────────────

export type HashlineEditItem =
  | { set_line: { anchor: string; new_text: string } }
  | { replace_lines: { start_anchor: string; end_anchor: string; new_text: string } }
  | { insert_after: { anchor: string; new_text: string; text?: string } }
  | { replace: { old_text: string; new_text: string; all?: boolean } };

interface HashMismatch {
  line: number;
  expected: string;
  actual: string;
  expectedContent?: string;
}

export class HashlineMismatchError extends Error {
  readonly updatedAnchors: PtcLine[];
  /** Every LINE:HASH the message shows, each naming that line of the content edited. */
  readonly shownAnchors: Array<{ line: number; hash: string }>;

  constructor(
    message: string,
    updatedAnchors: PtcLine[],
    shownAnchors: Array<{ line: number; hash: string }> = [],
  ) {
    super(message);
    this.name = "HashlineMismatchError";
    this.updatedAnchors = updatedAnchors;
    this.shownAnchors = shownAnchors;
  }
}

/** Anchored edits in one request whose spans overlap: applying them would write neither as sent. */
export class HashlineOverlapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HashlineOverlapError";
  }
}

type ParsedRef = { line: number; hash: string; content?: string };

type ParsedSpec =
  | { kind: "single"; ref: ParsedRef }
  | { kind: "range"; start: ParsedRef; end: ParsedRef }
  | { kind: "insertAfter"; after: ParsedRef };

interface ParsedEdit {
  spec: ParsedSpec;
  dstLines: string[];
}

interface NoopEdit {
  editIndex: number;
  loc: string;
  currentContent: string;
}

// ─── Hash computation ───────────────────────────────────────────────────

const HASH_LEN = 3;
const RADIX = 16;
const HASH_MOD = RADIX ** HASH_LEN;
const DICT = Array.from({ length: HASH_MOD }, (_, i) => i.toString(RADIX).padStart(HASH_LEN, "0"));

const HASH_RELOCATION_WINDOW_BASE = 20;
const HASH_RELOCATION_WINDOW_CAP = 100;

interface HashlineGlobalState {
  h32Fn: ((input: string, seed?: number) => number) | null;
  initPromise: Promise<void> | null;
}

const HASHLINE_STATE_KEY = Symbol.for("pi-hashline-readmap.hashlineState.v1");

function getHashlineState(): HashlineGlobalState {
  const globalObject = globalThis as any;
  globalObject[HASHLINE_STATE_KEY] ??= {
    h32Fn: null,
    initPromise: null,
  } satisfies HashlineGlobalState;
  return globalObject[HASHLINE_STATE_KEY] as HashlineGlobalState;
}

export async function ensureHashInit(): Promise<void> {
  const state = getHashlineState();
  if (state.h32Fn) return;
  if (!state.initPromise) {
    state.initPromise = xxhashWasm().then((hasher) => {
      state.h32Fn = hasher.h32;
    });
  }
  await state.initPromise;
}

function xxh32(input: string): number {
  const state = getHashlineState();
  if (!state.h32Fn) throw new Error("Hash not initialized — call ensureHashInit() first");
  return state.h32Fn(input, 0) >>> 0;
}

export function computeLineHash(_idx: number, line: string): string {
  if (line.endsWith("\r")) line = line.slice(0, -1);
  line = line.replace(/\s+/g, "");
  return DICT[xxh32(line) % HASH_MOD];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ASCII control characters for display escaping.
const DISPLAY_CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export function escapeControlCharsForDisplay(text: string): string {
  return text.replace(DISPLAY_CONTROL_CHAR_RE, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function formatHashlineDisplay(lineNumber: number, content: string): string {
  return `${lineNumber}:${computeLineHash(lineNumber, content)}|${escapeControlCharsForDisplay(content)}`;
}

export function hashLine(lineNumber: number, content: string): string {
  return formatHashlineDisplay(lineNumber, content);
}

export function hashLines(content: string): string {
  return content
    .split("\n")
    .map((line, i) => formatHashlineDisplay(i + 1, line))
    .join("\n");
}

// ─── Parsing ────────────────────────────────────────────────────────────

export function parseLineRef(ref: string): { line: number; hash: string; content?: string } {
  const contentMatch = ref.match(/^[^|]*\|(.*)$/);
  const contentAfterPipe = contentMatch ? contentMatch[1] : undefined;
  const cleaned = ref
    .replace(/\|.*$/, "")
    .replace(/ {2}.*$/, "")
    .trim();
  const normalized = cleaned.replace(/\s*:\s*/, ":");
  const match = normalized.match(new RegExp(`^(\\d+):([0-9a-fA-F]{${HASH_LEN}})$`));
  if (!match)
    throw new Error(`Invalid line reference "${ref}". Expected "LINE:HASH" (e.g. "5:abc").`);
  const line = Number.parseInt(match[1], 10);
  if (line < 1) throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
  return { line, hash: match[2], content: contentAfterPipe };
}

// ─── Mismatch formatting ────────────────────────────────────────────────

function tokenSimilarity(a: string, b: string): number {
  const tokA = new Set(a.trim().split(/\s+/));
  const tokB = new Set(b.trim().split(/\s+/));
  if (tokA.size === 0 && tokB.size === 0) return 1;
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokA) {
    if (tokB.has(t)) overlap++;
  }
  return overlap / Math.max(tokA.size, tokB.size);
}

function findSimilarLines(
  expectedContent: string,
  fileLines: string[],
  hintLine: number,
  maxSuggestions: number = 3,
): Array<{ line: number; hash: string; text: string }> {
  const SCAN_WINDOW = 50;
  const MIN_SIMILARITY = 0.3;
  const start = Math.max(0, hintLine - 1 - SCAN_WINDOW);
  const end = Math.min(fileLines.length, hintLine - 1 + SCAN_WINDOW + 1);
  const candidates: { line: number; score: number; content: string }[] = [];

  for (let i = start; i < end; i++) {
    const content = fileLines[i];
    if (!content.trim()) continue;
    const score = tokenSimilarity(expectedContent, content);
    if (score >= MIN_SIMILARITY) {
      candidates.push({ line: i + 1, score, content });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxSuggestions).map((c) => {
    const hash = computeLineHash(c.line, c.content);
    return {
      line: c.line,
      hash,
      text: `  ${c.line}:${hash}|${escapeControlCharsForDisplay(c.content)}`,
    };
  });
}
function formatMismatchError(
  mismatches: HashMismatch[],
  fileLines: string[],
  relocationWindow: number,
): {
  message: string;
  updatedAnchors: PtcLine[];
  shownAnchors: Array<{ line: number; hash: string }>;
} {
  const shownAnchors: Array<{ line: number; hash: string }> = [];
  const mismatchSet = new Map<number, HashMismatch>();
  for (const m of mismatches) mismatchSet.set(m.line, m);
  const updatedAnchors: PtcLine[] = mismatches.map((m) => {
    const raw = fileLines[m.line - 1] ?? "";
    const hash = computeLineHash(m.line, raw);
    return {
      line: m.line,
      hash,
      anchor: `${m.line}:${hash}`,
      raw,
      display: escapeControlCharsForDisplay(raw),
    };
  });
  const displayLines = new Set<number>();
  for (const m of mismatches) {
    for (let i = Math.max(1, m.line - 2); i <= Math.min(fileLines.length, m.line + 2); i++) {
      displayLines.add(i);
    }
  }
  const sorted = [...displayLines].sort((a, b) => a - b);
  const out: string[] = [
    "Edit rejected — nothing was written. The anchor hash did not match the current file content.",
    `${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Auto-relocation checks only within ±${relocationWindow} lines of each anchor. Use the updated LINE:HASH references shown below (>>> marks changed lines).`,
    "",
  ];
  let prev = -1;
  for (const num of sorted) {
    if (prev !== -1 && num > prev + 1) out.push("    ...");
    prev = num;
    const content = fileLines[num - 1];
    const hash = computeLineHash(num, content);
    shownAnchors.push({ line: num, hash });
    const prefix = `${num}:${hash}`;
    out.push(
      mismatchSet.has(num)
        ? `>>> ${prefix}|${escapeControlCharsForDisplay(content)}`
        : `    ${prefix}|${escapeControlCharsForDisplay(content)}`,
    );
  }
  const withContent = mismatches.filter((m) => m.expectedContent !== undefined);
  if (withContent.length > 0) {
    for (const m of withContent) {
      const suggestions = findSimilarLines(m.expectedContent!, fileLines, m.line);
      if (suggestions.length > 0) {
        out.push("");
        out.push("Did you mean one of these nearby lines?");
        out.push(...suggestions.map((c) => c.text));
        shownAnchors.push(...suggestions.map(({ line, hash }) => ({ line, hash })));
      }
    }
  }

  return { message: out.join("\n"), updatedAnchors, shownAnchors };
}

// ─── DST preprocessing helpers ──────────────────────────────────────────

function splitDst(dst: string): string[] {
  if (dst === "") return [];
  const normalized = dst.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
  return normalized.split("\n");
}

/**
 * Strip anchor prefixes a model copied from a view into new_text. A prefix counts only when its
 * hash matches the rest of its own line, so content that merely looks like `10:45|x` survives.
 * Diff `+` markers are not stripped: `+` starts real lines (Markdown lists, diff files).
 */
function stripNewLinePrefixes(lines: string[]): string[] {
  const copied = (l: string, re: RegExp) => {
    const m = re.exec(l);
    return m !== null && computeLineHash(0, l.slice(m[0].length)) === m[1].toLowerCase();
  };
  const full = /^\d+:([0-9a-fA-F]{3})\|/;
  const bare = /^([0-9a-f]{3})\|/;
  const nonEmpty = lines.filter((l) => l.length > 0);
  if (!nonEmpty.length) return lines;
  const fullCount = nonEmpty.filter((l) => copied(l, full)).length;
  if (fullCount > 0 && fullCount >= nonEmpty.length * 0.5) {
    return lines.map((l) => (copied(l, full) ? l.replace(full, "") : l));
  }
  const bareCount = nonEmpty.filter((l) => copied(l, bare)).length;
  if (nonEmpty.length >= 2 && bareCount >= nonEmpty.length * 0.5) {
    return lines.map((l) => (copied(l, bare) ? l.replace(bare, "") : l));
  }
  return lines;
}

// ─── Whitespace / format helpers ────────────────────────────────────────

// ─── Edit parser ────────────────────────────────────────────────────────

function parseHashlineEditItem(edit: HashlineEditItem): ParsedEdit {
  if ("set_line" in edit) {
    return {
      spec: { kind: "single", ref: parseLineRef(edit.set_line.anchor) },
      dstLines: stripNewLinePrefixes(splitDst(edit.set_line.new_text)),
    };
  }
  if ("replace_lines" in edit) {
    const start = parseLineRef(edit.replace_lines.start_anchor);
    const end = parseLineRef(edit.replace_lines.end_anchor);
    return {
      spec:
        start.line === end.line ? { kind: "single", ref: start } : { kind: "range", start, end },
      dstLines: stripNewLinePrefixes(splitDst(edit.replace_lines.new_text)),
    };
  }
  if ("insert_after" in edit) {
    return {
      spec: { kind: "insertAfter", after: parseLineRef(edit.insert_after.anchor) },
      dstLines: stripNewLinePrefixes(
        splitDst(edit.insert_after.new_text ?? edit.insert_after.text ?? ""),
      ),
    };
  }
  throw new Error("replace edits are applied separately");
}

// ─── Main edit engine ───────────────────────────────────────────────────

export function applyHashlineEdits(
  content: string,
  edits: HashlineEditItem[],
  signal?: AbortSignal,
  /**
   * relocate: false refuses a mismatched anchor instead of moving it to a nearby hash match.
   * origin: one entry per line of `content` (the original line it came from, or 0); every splice
   * the engine makes is mirrored into it, and a line an edit replaced or inserted becomes 0.
   */
  options: { relocate?: boolean; origin?: number[] } = {},
): {
  content: string;
  firstChangedLine: number | undefined;
  warnings?: string[];
  noopEdits?: NoopEdit[];
} {
  throwIfAborted(signal);
  if (!edits.length) return { content, firstChangedLine: undefined };

  // Compute adaptive relocation window based on edit batch size
  const relocationWindow = Math.min(
    Math.max(HASH_RELOCATION_WINDOW_BASE, edits.length * 5),
    HASH_RELOCATION_WINDOW_CAP,
  );

  const fileLines = content.split("\n");
  const origLines = [...fileLines];
  if (options.origin && options.origin.length !== fileLines.length) {
    throw new Error("origin must have one entry per line of content");
  }
  const spliceLines = (start: number, deleteCount: number, items: string[]) => {
    fileLines.splice(start, deleteCount, ...items);
    options.origin?.splice(start, deleteCount, ...items.map(() => 0));
  };
  let firstChanged: number | undefined;
  const noopEdits: NoopEdit[] = [];

  const parsed: (ParsedEdit & { idx: number })[] = edits.map((edit, idx) => ({
    ...parseHashlineEditItem(edit),
    idx,
  }));

  // Build hash index for local-window relocation
  const lineHashes: string[] = [];
  const hashToLines = new Map<string, number[]>();
  for (let i = 0; i < fileLines.length; i++) {
    throwIfAborted(signal);
    const lineNumber = i + 1;
    const h = computeLineHash(lineNumber, fileLines[i]);
    lineHashes.push(h);
    const lines = hashToLines.get(h);
    if (lines) lines.push(lineNumber);
    else hashToLines.set(h, [lineNumber]);
  }

  const relocationNotes = new Set<string>();

  function findRelocationLine(
    expectedHash: string,
    hintLine: number,
    relocationWindow: number,
  ): number | undefined {
    const candidates = hashToLines.get(expectedHash);
    if (!candidates?.length) return undefined;

    const minLine = Math.max(1, hintLine - relocationWindow);
    const maxLine = Math.min(fileLines.length, hintLine + relocationWindow);
    let match: number | undefined;
    for (const candidate of candidates) {
      if (candidate < minLine || candidate > maxLine) continue;
      if (match !== undefined) return undefined; // ambiguous within window
      match = candidate;
    }
    return match;
  }

  // Validate all refs before mutation
  const mismatches: HashMismatch[] = [];

  function validate(ref: ParsedRef): boolean {
    if (ref.line < 1 || ref.line > fileLines.length)
      throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
    const expected = ref.hash.toLowerCase();
    const originalLine = ref.line;
    const actual = lineHashes[originalLine - 1];
    if (actual === expected) return true;
    if (options.relocate === false) {
      mismatches.push({ line: originalLine, expected: ref.hash, actual });
      return false;
    }
    const relocated = findRelocationLine(expected, originalLine, relocationWindow);
    if (relocated !== undefined) {
      ref.line = relocated;
      relocationNotes.add(
        `Auto-relocated anchor ${originalLine}:${ref.hash} -> ${relocated}:${ref.hash} (window ±${relocationWindow}).`,
      );
      return true;
    }
    // Fuzzy content-based recovery: if anchor includes content after pipe,
    // look for a nearby line with high token similarity
    if (ref.content) {
      const FUZZY_THRESHOLD = 0.8;
      const FUZZY_SCAN = 50;
      const scanStart = Math.max(0, originalLine - 1 - FUZZY_SCAN);
      const scanEnd = Math.min(fileLines.length, originalLine - 1 + FUZZY_SCAN + 1);
      const fuzzyHits: { line: number; score: number }[] = [];
      for (let i = scanStart; i < scanEnd; i++) {
        const lineContent = fileLines[i];
        if (!lineContent.trim()) continue;
        const score = tokenSimilarity(ref.content, lineContent);
        if (score > FUZZY_THRESHOLD) {
          fuzzyHits.push({ line: i + 1, score });
        }
      }
      if (fuzzyHits.length === 1) {
        const hit = fuzzyHits[0];
        const newHash = computeLineHash(hit.line, fileLines[hit.line - 1]);
        ref.line = hit.line;
        ref.hash = newHash;
        relocationNotes.add(
          `Fuzzy-relocated anchor ${originalLine}:${expected} \u2192 ${hit.line}:${newHash} (similarity: ${hit.score.toFixed(2)})`,
        );
        return true;
      }
    }
    mismatches.push({
      line: originalLine,
      expected: ref.hash,
      actual,
      expectedContent: ref.content,
    });
    return false;
  }

  for (const { spec } of parsed) {
    throwIfAborted(signal);
    if (spec.kind === "single") {
      validate(spec.ref);
    } else if (spec.kind === "insertAfter") {
      validate(spec.after);
    } else {
      // Range: validate start > end before relocation
      if (spec.start.line > spec.end.line) {
        throw new Error(`Range start line ${spec.start.line} must be <= end line ${spec.end.line}`);
      }

      const originalStart = spec.start.line;
      const originalEnd = spec.end.line;
      const originalCount = originalEnd - originalStart + 1;

      const startOk = validate(spec.start);
      const endOk = validate(spec.end);

      // If both validated but relocation invalidated the range, revert and report mismatch
      if (startOk && endOk) {
        const relocatedCount = spec.end.line - spec.start.line + 1;
        const invalidRange = spec.start.line > spec.end.line;
        const scopeChanged = relocatedCount !== originalCount;
        if (invalidRange || scopeChanged) {
          spec.start.line = originalStart;
          spec.end.line = originalEnd;
          mismatches.push(
            {
              line: originalStart,
              expected: spec.start.hash,
              actual: lineHashes[originalStart - 1],
            },
            { line: originalEnd, expected: spec.end.hash, actual: lineHashes[originalEnd - 1] },
          );
        }
      }
    }
  }
  if (mismatches.length) {
    const formatted = formatMismatchError(mismatches, fileLines, relocationWindow);
    throw new HashlineMismatchError(
      formatted.message,
      formatted.updatedAnchors,
      formatted.shownAnchors,
    );
  }

  // Collapse identical duplicate edits (conflicting ones are refused as overlaps below).
  // For single-target edits, keep the last identical occurrence so resolution remains last-wins.
  const seenSingleEditByKey = new Map<string, number>();
  const seenNonSingleEditByKey = new Map<string, number>();
  const dupes = new Set<number>();
  for (let i = 0; i < parsed.length; i++) {
    throwIfAborted(signal);
    const p = parsed[i];
    const lk =
      p.spec.kind === "single"
        ? `s:${p.spec.ref.line}`
        : p.spec.kind === "range"
          ? `r:${p.spec.start.line}:${p.spec.end.line}`
          : `i:${p.spec.after.line}`;
    const dstKey = p.dstLines.join("\n");
    const key = `${lk}|${dstKey}`;
    if (p.spec.kind === "single") {
      const previousIdx = seenSingleEditByKey.get(key);
      if (previousIdx !== undefined) dupes.add(previousIdx);
      seenSingleEditByKey.set(key, i);
      continue;
    }
    if (seenNonSingleEditByKey.has(key)) {
      dupes.add(i);
    } else {
      seenNonSingleEditByKey.set(key, i);
    }
  }
  const deduped = parsed.filter((_, i) => !dupes.has(i));

  // An insert_after on the last line a replacement covers goes right after that replacement's
  // lines ("change line N, then add lines after it"), in request order.
  const merged = deduped.filter((p) => {
    if (p.spec.kind !== "insertAfter") return true;
    const after = p.spec.after.line;
    const host = deduped.find(
      (q) =>
        (q.spec.kind === "single" && q.spec.ref.line === after) ||
        (q.spec.kind === "range" && q.spec.end.line === after),
    );
    if (!host) return true;
    host.dstLines = [...host.dstLines, ...p.dstLines];
    return false;
  });

  // Overlapping spans cannot all be written as sent: refuse instead of guessing.
  const spans = merged.map((p) =>
    p.spec.kind === "single"
      ? { idx: p.idx, from: p.spec.ref.line, to: p.spec.ref.line, insert: false }
      : p.spec.kind === "range"
        ? { idx: p.idx, from: p.spec.start.line, to: p.spec.end.line, insert: false }
        : { idx: p.idx, from: p.spec.after.line, to: p.spec.after.line, insert: true },
  );
  for (let x = 0; x < spans.length; x++) {
    for (let y = x + 1; y < spans.length; y++) {
      const [a, b] = [spans[x], spans[y]];
      if (a.insert && b.insert) continue;
      if (a.from <= b.to && b.from <= a.to) {
        const describe = (s: typeof a) =>
          s.insert ? `insert_after line ${s.from}` : `lines ${s.from}-${s.to}`;
        throw new HashlineOverlapError(
          `Edit rejected — nothing was written. edits[${a.idx}] (${describe(a)}) and edits[${b.idx}] (${describe(b)}) overlap. Combine them into one replace_lines whose new_text holds the final lines.`,
        );
      }
    }
  }

  // Sort bottom-up for stable splice
  const sorted = merged
    .map((p) => {
      const sl =
        p.spec.kind === "single"
          ? p.spec.ref.line
          : p.spec.kind === "range"
            ? p.spec.end.line
            : p.spec.after.line;
      const pr = p.spec.kind === "insertAfter" ? 1 : 0;
      return { ...p, sl, pr };
    })
    // Same-line inserts apply last-first, so they land in request order.
    .sort((a, b) => b.sl - a.sl || a.pr - b.pr || (a.pr ? b.idx - a.idx : a.idx - b.idx));

  function track(line: number) {
    if (firstChanged === undefined || line < firstChanged) firstChanged = line;
  }

  // Apply edits bottom-up, each exactly as sent.
  const sameAsOrig = (orig: string[], next: string[]) =>
    orig.length === next.length && orig.join("\n") === next.join("\n");
  for (const { spec, dstLines, idx } of sorted) {
    throwIfAborted(signal);
    if (spec.kind === "single" || spec.kind === "range") {
      const start = spec.kind === "single" ? spec.ref.line : spec.start.line;
      const count = spec.kind === "single" ? 1 : spec.end.line - spec.start.line + 1;
      const hash = spec.kind === "single" ? spec.ref.hash : spec.start.hash;
      const orig = origLines.slice(start - 1, start - 1 + count);
      const newL = dstLines;
      if (sameAsOrig(orig, newL)) {
        noopEdits.push({
          editIndex: idx,
          loc: `${start}:${hash}`,
          currentContent: orig.join("\n"),
        });
        continue;
      }
      spliceLines(start - 1, count, newL);
      track(start);
    } else {
      const anchor = origLines[spec.after.line - 1];
      if (!dstLines.length) {
        noopEdits.push({
          editIndex: idx,
          loc: `${spec.after.line}:${spec.after.hash}`,
          currentContent: anchor,
        });
        continue;
      }
      if (content === "" && spec.after.line === 1 && anchor === "") {
        spliceLines(0, 1, dstLines);
        track(1);
        continue;
      }
      spliceLines(spec.after.line, 0, dstLines);
      track(spec.after.line + 1);
    }
  }

  const warnings: string[] = [...relocationNotes];

  return {
    content: fileLines.join("\n"),
    firstChangedLine: firstChanged,
    ...(warnings.length ? { warnings } : {}),
    ...(noopEdits.length ? { noopEdits } : {}),
  };
}
