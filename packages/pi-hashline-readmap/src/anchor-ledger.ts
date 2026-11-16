/**
 * Anchor ledger: which LINE:HASH anchors the model has been shown for the current content of
 * each file, and where each one sits now.
 *
 * A hash alone cannot prove an anchor is current. It covers one line's whitespace-stripped text
 * in 12 bits, with no line number, so a shifted `}` or blank line still verifies. The ledger
 * accepts an anchor only when it was issued (by read, grep, ast_search, write, or edit) and the
 * line it names is known. The edit tool carries issued anchors through its own edits by tracking
 * every splice it makes (see lineMapFromOrigin), so an anchor the model already holds for a line
 * the edit did not touch keeps working under the line number it was issued with. Any change the ledger did not make (a shell command, a formatter, the
 * user) clears the file's anchors: the file stamp no longer matches.
 *
 * An anchor the model renumbered itself, `N:H` for a shown line now tracked at N, is accepted
 * too: it names the same line.
 *
 * Keys can collide: an anchor carried to line M keeps its old key `N:H`, and a later view or edit
 * result can show the current line N under the same key. Neither wins silently. The key is
 * contested, its next use is refused with both lines shown, and only that refusal resolves it.
 */
import { type BigIntStats, statSync } from "node:fs";
import { normalizePathForContextHygiene } from "./context-hygiene.js";
import { computeLineHash } from "./hashline.js";

export interface IssuedAnchor {
  line: number;
  hash: string;
}

/**
 * A refused ref and the current lines it names: none (not issued) or several (ambiguous).
 * `evicted`: the key once named a line the ledger stopped tracking (memory cap), so a line it
 * names now may not be the one the model holds it for.
 */
export interface StaleAnchor extends IssuedAnchor {
  candidates: number[];
  evicted?: boolean;
}

export type AnchorCheck =
  /** `lines[i]` is the current line of `refs[i]`. */
  | { kind: "ok"; lines: number[] }
  | { kind: "not-read" }
  | { kind: "stale"; refs: StaleAnchor[]; changedOutside: boolean };

/** The slice of the ledger the edit tool needs; tests can supply their own. */
export interface AnchorGuard {
  wasObserved(absolutePath: string): boolean;
  check(absolutePath: string, currentLines: readonly string[], refs: IssuedAnchor[]): AnchorCheck;
  issue(absolutePath: string, anchors: Iterable<IssuedAnchor>, stamp?: Stamp): void;
  /** After refusing an ambiguous key: it now names only its own line, or nothing. */
  resolve(absolutePath: string, ref: IssuedAnchor): void;
  recordEdit(absolutePath: string, lineMap: LineMap, fresh: Iterable<IssuedAnchor>): void;
}

export type Stamp = string | undefined;

interface FileAnchors {
  stamp: Stamp;
  /** `${line}:${hash}` as issued → the current line(s) it names. Two lines means ambiguous. */
  anchors: Map<string, Set<number>>;
  /** Keys whose carried meaning was dropped by the memory cap: refused once before reuse. */
  evicted: Set<string>;
}

/** File identity and version: inode, size and mtime in ns. Taken before a read, it ties the anchors
 * the read shows to the content it read. */
export function stampOf(absolutePath: string): Stamp {
  let stats: BigIntStats | undefined;
  try {
    stats = statSync(absolutePath, { bigint: true, throwIfNoEntry: false });
  } catch {
    return undefined;
  }
  return stats ? `${stats.ino}:${stats.size}:${stats.mtimeNs}` : undefined;
}

const keyOf = (line: number, hash: string) => `${line}:${hash.toLowerCase()}`;
const lineOfKey = (key: string) => Number(key.slice(0, key.indexOf(":")));
/** Carried aliases are evicted past this many keys per current line of the file, plus slack. */
const KEYS_PER_LINE_CAP = 8;
const KEY_SLACK = 256;

function add(anchors: Map<string, Set<number>>, key: string, line: number) {
  const lines = anchors.get(key);
  if (lines) lines.add(line);
  else anchors.set(key, new Set([line]));
}

export class AnchorLedger implements AnchorGuard {
  readonly #files = new Map<string, FileAnchors>();
  readonly #keysPerLine: number;
  readonly #keySlack: number;

  constructor(options: { keysPerLine?: number; keySlack?: number } = {}) {
    this.#keysPerLine = options.keysPerLine ?? KEYS_PER_LINE_CAP;
    this.#keySlack = options.keySlack ?? KEY_SLACK;
  }

  #state(absolutePath: string): FileAnchors | undefined {
    return this.#files.get(normalizePathForContextHygiene(absolutePath));
  }

  wasObserved(absolutePath: string): boolean {
    return this.#state(absolutePath) !== undefined;
  }

  /**
   * Record anchors a view (read, grep, ast_search, write, an edit refusal) just showed for the
   * file. `stamp` is the file's stamp when the view read it (default: now). A key already carried
   * to another line becomes contested rather than replaced.
   */
  issue(
    absolutePath: string,
    anchors: Iterable<IssuedAnchor>,
    stamp: Stamp = stampOf(absolutePath),
  ): void {
    const key = normalizePathForContextHygiene(absolutePath);
    let state = this.#files.get(key);
    if (!state) {
      state = { stamp, anchors: new Map(), evicted: new Set() };
      this.#files.set(key, state);
    } else if (state.stamp !== stamp) {
      // Changed outside edit: no position survives, so start over from this view. (Tombstoning
      // carried keys here would refuse the common case, a fresh anchor after a re-read.)
      state.stamp = stamp;
      state.anchors = new Map();
      state.evicted = new Set();
    }
    for (const anchor of anchors) add(state.anchors, keyOf(anchor.line, anchor.hash), anchor.line);
  }

  resolve(absolutePath: string, ref: IssuedAnchor): void {
    const state = this.#state(absolutePath);
    if (!state) return;
    const key = keyOf(ref.line, ref.hash);
    state.evicted.delete(key);
    if (state.anchors.get(key)?.has(ref.line)) state.anchors.set(key, new Set([ref.line]));
    else state.anchors.delete(key);
  }

  /** Drop the file's anchors, keeping it observed. For changes made outside the edit tool. */
  forget(absolutePath: string): void {
    const state = this.#state(absolutePath);
    if (state) {
      state.anchors = new Map();
      state.evicted = new Set();
    }
  }

  /**
   * Resolve each ref to its current line. A ref passes only when it was issued for the current
   * content, names exactly one line, and that line still hashes to it.
   */
  check(absolutePath: string, currentLines: readonly string[], refs: IssuedAnchor[]): AnchorCheck {
    const state = this.#state(absolutePath);
    if (!state) return { kind: "not-read" };
    const stamp = stampOf(absolutePath);
    const changedOutside = state.stamp !== stamp;
    if (changedOutside) {
      state.stamp = stamp;
      state.anchors = new Map();
      state.evicted = new Set();
    }
    const lines: number[] = [];
    const stale: StaleAnchor[] = [];
    for (const ref of refs) {
      const hash = ref.hash.toLowerCase();
      const key = keyOf(ref.line, hash);
      const named = [...(state.anchors.get(key) ?? [])].filter((line) => {
        const text = currentLines[line - 1];
        return text !== undefined && computeLineHash(line, text) === hash;
      });
      // A model often shifts an anchor it holds by the lines its own edit inserted. Accept N:H
      // when an anchor shown for this hash is now tracked at line N: that is the line it saw.
      if (
        !named.includes(ref.line) &&
        computeLineHash(ref.line, currentLines[ref.line - 1] ?? "") === hash &&
        currentLines[ref.line - 1] !== undefined &&
        this.#tracksLine(state, hash, ref.line)
      ) {
        named.push(ref.line);
      }
      const evicted = state.evicted.has(key);
      if (named.length === 1 && !evicted) lines.push(named[0]);
      else
        stale.push({
          ...ref,
          candidates: named.sort((x, y) => x - y),
          ...(evicted ? { evicted } : {}),
        });
    }
    return stale.length ? { kind: "stale", refs: stale, changedOutside } : { kind: "ok", lines };
  }

  /** Whether any anchor issued with this hash currently names `line`. */
  #tracksLine(state: FileAnchors, hash: string, line: number): boolean {
    const suffix = `:${hash}`;
    for (const [key, lines] of state.anchors) {
      if (key.endsWith(suffix) && lines.has(line)) return true;
    }
    return false;
  }

  /**
   * After the edit tool writes the file: move every anchor whose line survived unchanged to its
   * new line, drop the rest, then add the anchors the edit result shows.
   */
  recordEdit(absolutePath: string, lineMap: LineMap, fresh: Iterable<IssuedAnchor>): void {
    const key = normalizePathForContextHygiene(absolutePath);
    const moved = new Map<string, Set<number>>();
    const evicted = this.#files.get(key)?.evicted ?? new Set<string>();
    for (const [anchorKey, lines] of this.#files.get(key)?.anchors ?? []) {
      for (const line of lines) {
        const next = lineMap.oldToNew[line - 1];
        if (next) add(moved, anchorKey, next);
      }
    }
    for (const anchor of fresh) add(moved, keyOf(anchor.line, anchor.hash), anchor.line);
    if (moved.size > this.#keysPerLine * lineMap.newLength + this.#keySlack) {
      // Drop carried meanings but remember their keys: a later view of the same key must not
      // silently bind it to another line while the model may still hold the old meaning.
      for (const [anchorKey, lines] of moved) {
        const own = lineOfKey(anchorKey);
        if (lines.size === 1 && lines.has(own)) continue;
        evicted.add(anchorKey);
        if (lines.has(own)) moved.set(anchorKey, new Set([own]));
        else moved.delete(anchorKey);
      }
    }
    this.#files.set(key, { stamp: stampOf(absolutePath), anchors: moved, evicted });
  }
}

export interface LineMap {
  /** 1-based new line of each old line (index = old line - 1); 0 when the line did not survive. */
  oldToNew: Int32Array;
  /** 1-based inclusive ranges of new lines that the edit added or changed. */
  changed: Array<[number, number]>;
  /** 1-based new line just after each pure deletion (lines removed, none added). */
  deletions: number[];
  /** Line count after the edit. */
  newLength: number;
}

/**
 * The line map of an edit from each new line's origin (its 1-based line before the edit, or 0
 * for a line the edit inserted or replaced). The edit tool builds `origin` from its own splices,
 * not from a content diff: a diff slides across identical lines (a blank line, a `}`) and would
 * carry an anchor onto an inserted duplicate.
 */
export function lineMapFromOrigin(origin: readonly number[], oldLength: number): LineMap {
  const oldToNew = new Int32Array(oldLength);
  const changed: Array<[number, number]> = [];
  const deletions: number[] = [];
  let prevOrigin = 0;
  let runStart = 0;
  for (let i = 0; i <= origin.length; i++) {
    const o = i < origin.length ? origin[i] : oldLength + 1;
    if (o === 0) {
      if (!runStart) runStart = i + 1;
      continue;
    }
    if (runStart) {
      changed.push([runStart, i]);
      runStart = 0;
    } else if (o > prevOrigin + 1) {
      deletions.push(i + 1);
    }
    if (i < origin.length) oldToNew[o - 1] = i + 1;
    prevOrigin = o;
  }
  return { oldToNew, changed, deletions, newLength: origin.length };
}

/** Mirror a text replacement into `origin`: every line a replaced span touches becomes 0. */
export function spliceOriginForSpans(
  origin: number[],
  content: string,
  spans: ReadonlyArray<{ index: number; matchLength: number }>,
  newText: string,
): void {
  const starts = [0];
  for (let at = content.indexOf("\n"); at !== -1; at = content.indexOf("\n", at + 1)) {
    starts.push(at + 1);
  }
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const newLines = newText.split("\n").length;
  for (const span of [...spans].sort((x, y) => y.index - x.index)) {
    const first = lineAt(span.index);
    const last = lineAt(span.index + span.matchLength);
    origin.splice(first, last - first + 1, ...Array.from({ length: newLines }, () => 0));
  }
}

const ANCHOR_LINE_RE = /^(?:>>>? ?|\s+)?(\d+):([0-9a-f]{3})\|/gm;

/** Every `LINE:HASH|` anchor a tool result shows, as the model sees it. */
export function anchorsInText(text: string): IssuedAnchor[] {
  return [...text.matchAll(ANCHOR_LINE_RE)].map((m) => ({ line: Number(m[1]), hash: m[2] }));
}

const CONTEXT_LINES = 2;
const REGION_MAX_LINES = 16;
const REGION_EDGE_LINES = 6;
const TOTAL_MAX_LINES = 48;

/**
 * The anchors an edit result shows: each changed region with two lines of context. A long region
 * shows its first and last lines; past the total budget the rest are counted, not shown.
 */
export function freshAnchorWindows(
  lines: readonly string[],
  lineMap: LineMap,
): { shown: number[][]; omittedRegions: number } {
  const spans = [
    ...lineMap.changed,
    ...lineMap.deletions.map((line): [number, number] => [line, line - 1]),
  ]
    .map(([start, end]): [number, number] => [
      Math.max(1, start - CONTEXT_LINES),
      Math.min(lines.length, Math.max(start, end) + CONTEXT_LINES),
    ])
    .filter(([start, end]) => start <= end)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  const shown: number[][] = [];
  let budget = TOTAL_MAX_LINES;
  let omittedRegions = 0;
  for (const [start, end] of merged) {
    const all = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    const region =
      all.length > REGION_MAX_LINES
        ? [...all.slice(0, REGION_EDGE_LINES), ...all.slice(-REGION_EDGE_LINES)]
        : all;
    if (region.length > budget) {
      omittedRegions += 1;
      continue;
    }
    budget -= region.length;
    shown.push(region);
  }
  return { shown, omittedRegions };
}
