/**
 * Anchor ledger: which LINE:HASH anchors the model has been shown for the current content of
 * each file, and where each one sits now.
 *
 * A hash alone cannot prove an anchor is current. It covers one line's whitespace-stripped text
 * in 12 bits, with no line number, so a shifted `}` or blank line still verifies. The ledger
 * accepts an anchor only when it was issued (by read, grep, ast_search, write, or edit) and the
 * line it names is known. The edit tool carries issued anchors through its own edits with a line
 * diff, so an anchor the model already holds for an unchanged line keeps working under the line
 * number it was issued with. Any change the ledger did not make (a shell command, a formatter, the
 * user) clears the file's anchors: the file stamp no longer matches.
 */
import { type BigIntStats, statSync } from "node:fs";
import { diffArrays } from "diff";
import { normalizePathForContextHygiene } from "./context-hygiene.js";
import { computeLineHash } from "./hashline.js";

export interface IssuedAnchor {
  line: number;
  hash: string;
}

export type AnchorCheck =
  /** `lines[i]` is the current line of `refs[i]`. */
  | { kind: "ok"; lines: number[] }
  | { kind: "not-read" }
  | { kind: "stale"; refs: IssuedAnchor[]; changedOutside: boolean };

/** The slice of the ledger the edit tool needs; tests can supply their own. */
export interface AnchorGuard {
  wasObserved(absolutePath: string): boolean;
  check(absolutePath: string, currentLines: readonly string[], refs: IssuedAnchor[]): AnchorCheck;
  issue(absolutePath: string, anchors: Iterable<IssuedAnchor>): void;
  recordEdit(absolutePath: string, lineMap: LineMap, fresh: Iterable<IssuedAnchor>): void;
}

type Stamp = string | undefined;

interface FileAnchors {
  stamp: Stamp;
  /** `${line}:${hash}` as issued → the current line(s) it names. Two lines means ambiguous. */
  anchors: Map<string, Set<number>>;
}

function stampOf(absolutePath: string): Stamp {
  let stats: BigIntStats | undefined;
  try {
    stats = statSync(absolutePath, { bigint: true, throwIfNoEntry: false });
  } catch {
    return undefined;
  }
  return stats ? `${stats.ino}:${stats.size}:${stats.mtimeNs}` : undefined;
}

const keyOf = (line: number, hash: string) => `${line}:${hash.toLowerCase()}`;

function add(anchors: Map<string, Set<number>>, key: string, line: number) {
  const lines = anchors.get(key);
  if (lines) lines.add(line);
  else anchors.set(key, new Set([line]));
}

export class AnchorLedger implements AnchorGuard {
  readonly #files = new Map<string, FileAnchors>();

  #state(absolutePath: string): FileAnchors | undefined {
    return this.#files.get(normalizePathForContextHygiene(absolutePath));
  }

  wasObserved(absolutePath: string): boolean {
    return this.#state(absolutePath) !== undefined;
  }

  /** Record anchors just shown for the file as it is on disk now. */
  issue(absolutePath: string, anchors: Iterable<IssuedAnchor>): void {
    const key = normalizePathForContextHygiene(absolutePath);
    const stamp = stampOf(absolutePath);
    let state = this.#files.get(key);
    if (!state || state.stamp !== stamp) {
      state = { stamp, anchors: new Map() };
      this.#files.set(key, state);
    }
    for (const anchor of anchors) add(state.anchors, keyOf(anchor.line, anchor.hash), anchor.line);
  }

  /** Drop the file's anchors, keeping it observed. For changes made outside the edit tool. */
  forget(absolutePath: string): void {
    const state = this.#state(absolutePath);
    if (state) state.anchors = new Map();
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
    }
    const lines: number[] = [];
    const stale: IssuedAnchor[] = [];
    for (const ref of refs) {
      const named = state.anchors.get(keyOf(ref.line, ref.hash));
      const line = named?.size === 1 ? [...named][0] : undefined;
      const text = line === undefined ? undefined : currentLines[line - 1];
      if (
        line === undefined ||
        text === undefined ||
        computeLineHash(line, text) !== ref.hash.toLowerCase()
      ) {
        stale.push(ref);
      } else {
        lines.push(line);
      }
    }
    return stale.length ? { kind: "stale", refs: stale, changedOutside } : { kind: "ok", lines };
  }

  /**
   * After the edit tool writes the file: move every anchor whose line survived unchanged to its
   * new line, drop the rest, then add the anchors the edit result shows.
   */
  recordEdit(absolutePath: string, lineMap: LineMap, fresh: Iterable<IssuedAnchor>): void {
    const key = normalizePathForContextHygiene(absolutePath);
    const moved = new Map<string, Set<number>>();
    for (const [anchorKey, lines] of this.#files.get(key)?.anchors ?? []) {
      for (const line of lines) {
        const next = lineMap.oldToNew[line - 1];
        if (next) add(moved, anchorKey, next);
      }
    }
    for (const anchor of fresh) add(moved, keyOf(anchor.line, anchor.hash), anchor.line);
    this.#files.set(key, { stamp: stampOf(absolutePath), anchors: moved });
  }
}

export interface LineMap {
  /** 1-based new line of each old line (index = old line - 1); 0 when the line did not survive. */
  oldToNew: Int32Array;
  /** 1-based inclusive ranges of new lines that the edit added or changed. */
  changed: Array<[number, number]>;
  /** 1-based new line just after each pure deletion (lines removed, none added). */
  deletions: number[];
}

export function diffLineMap(before: readonly string[], after: readonly string[]): LineMap {
  const oldToNew = new Int32Array(before.length);
  const changed: Array<[number, number]> = [];
  const deletions: number[] = [];
  let oldIdx = 0;
  let newIdx = 0;
  let pendingRemoval = false;
  for (const part of diffArrays(before as string[], after as string[])) {
    const count = part.count ?? part.value.length;
    if (part.added) {
      changed.push([newIdx + 1, newIdx + count]);
      newIdx += count;
      pendingRemoval = false;
    } else if (part.removed) {
      oldIdx += count;
      pendingRemoval = true;
    } else {
      if (pendingRemoval) deletions.push(newIdx + 1);
      pendingRemoval = false;
      for (let i = 0; i < count; i++) oldToNew[oldIdx + i] = newIdx + i + 1;
      oldIdx += count;
      newIdx += count;
    }
  }
  if (pendingRemoval) deletions.push(newIdx + 1);
  return { oldToNew, changed, deletions };
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
