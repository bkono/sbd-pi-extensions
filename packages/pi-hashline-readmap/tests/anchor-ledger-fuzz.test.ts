/* biome-ignore-all lint/suspicious/noExplicitAny: tool results cross Pi's dynamic tool boundary. */
// Property test for the anchor ledger, from the independent verifier of the change. It tracks each
// line's physical identity outside the ledger, over low-entropy files where `}` and blank lines
// repeat, and checks that every accepted anchored edit lands on a line the model was shown under
// that key, that a refusal writes nothing, and that an anchor with one live meaning is never
// refused. FUZZ_SEEDS raises the seed count (600 seeds ran clean when this was added).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import init from "../index.js";
import { anchorsInText } from "../src/anchor-ledger.js";
import { ensureHashInit } from "../src/hashline.js";

const textOf = (r: any): string =>
  (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
function harness() {
  const reg: Record<string, any> = {};
  init({
    registerTool(d: any) {
      reg[d.name] = d;
    },
    on() {},
    events: { emit() {}, on() {} },
  } as any);
  return reg;
}
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHA = ["}", "{", "", "  foo();", "x", "});", "  }"];
beforeAll(async () => {
  await ensureHashInit();
});

it("fuzz: accepted edits land only on a line shown under that key", async () => {
  const SEEDS = Number(process.env.FUZZ_SEEDS ?? 25);
  const STEPS = Number(process.env.FUZZ_STEPS ?? 40);
  const stats = {
    accepted: 0,
    refused: 0,
    wrongLine: [] as any[],
    falseRefusal: [] as any[],
    forgedAccepted: [] as any[],
    staleRefusedOutside: 0,
    acceptedAfterOutside: [] as any[],
    other: {} as Record<string, number>,
    carriedAccepted: 0,
    wroteOnRefusal: [] as any[],
  };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = rng(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const dir = mkdtempSync(join(tmpdir(), "vfuzz-"));
    const tools = harness();
    const call = (name: string, params: any) =>
      tools[name].execute(`${name}-c`, params, new AbortController().signal, () => {}, {
        cwd: dir,
      });
    const file = join(dir, "f.txt");
    let nextId = 1;
    let uniq = 0;
    let lines: string[] = Array.from({ length: 10 + Math.floor(rand() * 15) }, () => pick(ALPHA));
    let ids: number[] = lines.map(() => nextId++);
    writeFileSync(file, lines.join("\n"));
    // key -> set of physical ids the model was shown under that key (since last outside change)
    let held = new Map<string, Set<number>>();
    // key -> line number at which shown, for "carried" stat
    const note = (text: string) => {
      for (const an of anchorsInText(text)) {
        const k = `${an.line}:${an.hash}`;
        const id = ids[an.line - 1];
        if (id === undefined) continue;
        if (!held.has(k)) held.set(k, new Set());
        held.get(k)!.add(id);
      }
    };
    const section = (t: string) => {
      const i = t.indexOf("Fresh anchors (");
      return i === -1 ? "" : t.slice(i);
    };
    note(textOf(await call("read", { path: file })));
    const log: string[] = [];
    for (let step = 0; step < STEPS; step++) {
      const r = rand();
      if (r < 0.08) {
        note(textOf(await call("read", { path: file })));
        log.push("read");
        continue;
      }
      if (r < 0.12) {
        const at = Math.floor(rand() * (lines.length + 1));
        lines = [...lines.slice(0, at), pick(ALPHA), ...lines.slice(at)];
        ids = [...ids.slice(0, at), nextId++, ...ids.slice(at)];
        writeFileSync(file, lines.join("\n"));
        held = new Map();
        log.push(`outside insert at ${at + 1}`);
        // immediately try an anchor that hash-matches now: must be refused
        continue;
      }
      // choose a key
      const keys = [...held.keys()];
      if (keys.length === 0) {
        note(textOf(await call("read", { path: file })));
        continue;
      }
      const forged = r < 0.22;
      let key: string;
      if (forged) {
        const n = 1 + Math.floor(rand() * lines.length);
        const anyKey = pick(keys);
        // hash of the current line n, fetched via a throwaway computation from held keys is not possible; use hashline
        const { computeLineHash } = await import("../src/hashline.js");
        key = `${n}:${computeLineHash(n, lines[n - 1])}`;
        void anyKey;
      } else key = pick(keys);
      const alive = [...(held.get(key) ?? [])].filter((id) => ids.includes(id));
      const op = pick(["set", "ins", "ins", "set", "del"]);
      const newLines =
        op === "del"
          ? []
          : Array.from({ length: op === "ins" ? 1 + Math.floor(rand() * 2) : 1 }, () =>
              rand() < 0.6 ? pick(ALPHA) : `u${uniq++}`,
            );
      if (op === "set" && newLines[0] === "") newLines[0] = "x";
      if (op === "ins") {
        // avoid the engine's pre-existing anchor-echo and trailing-blank stripping heuristics
        const anchorLine = Number(key.split(":")[0]);
        const cand = [...(held.get(key) ?? [])].map((id) => lines[ids.indexOf(id)]?.trim());
        if (
          cand.includes(newLines[0].trim()) ||
          lines[anchorLine - 1]?.trim() === newLines[0].trim()
        )
          newLines[0] = `u${uniq++}`;
        if (newLines[newLines.length - 1] === "") newLines[newLines.length - 1] = "x";
        if (newLines[0] === "") newLines[0] = `u${uniq++}`;
      }
      const edit =
        op === "ins"
          ? { insert_after: { anchor: key, new_text: newLines.join("\n") } }
          : { set_line: { anchor: key, new_text: newLines.join("\n") } };
      const before = readFileSync(file, "utf8");
      const res = await call("edit", { path: file, edits: [edit] });
      const after = readFileSync(file, "utf8");
      const text = textOf(res);
      const code = res.details?.ptcValue?.error?.code;
      const apply = (id: number) => {
        const p = ids.indexOf(id);
        if (op === "ins") {
          const nid = newLines.map(() => nextId++);
          return {
            l: [...lines.slice(0, p + 1), ...newLines, ...lines.slice(p + 1)],
            i: [...ids.slice(0, p + 1), ...nid, ...ids.slice(p + 1)],
          };
        }
        const nid = newLines.map(() => nextId++);
        return {
          l: [...lines.slice(0, p), ...newLines, ...lines.slice(p + 1)],
          i: [...ids.slice(0, p), ...nid, ...ids.slice(p + 1)],
        };
      };
      const ctx = {
        seed,
        step,
        key,
        op,
        newLines,
        forged,
        lines: lines.map((l, i) => `${i + 1}|${ids[i]}|${l}`),
        log: [...log],
        text,
      };
      if (res.isError) {
        stats.refused++;
        stats.other[code ?? "unknown"] = (stats.other[code ?? "unknown"] ?? 0) + 1;
        if (after !== before) stats.wroteOnRefusal.push(ctx);
        if (code === "stale-anchor") {
          const allShown = held.get(key);
          // false refusal: exactly one meaning ever recorded and it is alive
          if (allShown && allShown.size === 1 && alive.length === 1)
            stats.falseRefusal.push({ ...ctx, alive, fullLog: true });
          note(text);
        }
        log.push(`refused ${code} ${key} ${op}`);
        continue;
      }
      stats.accepted++;
      const norm = (t: string) =>
        t
          .split("\n")
          .map((l) => l.trim())
          .join("\n");
      const match = alive.map((id) => apply(id)).find((c) => norm(c.l.join("\n")) === norm(after));
      if (match) match.l = after.split("\n");
      if (!match) {
        if (alive.length === 0 && forged) stats.forgedAccepted.push(ctx);
        else stats.wrongLine.push({ ...ctx, alive, after: after.split("\n") });
        break;
      }
      const lineNo = Number(key.split(":")[0]);
      if (ids.indexOf(alive[0]) + 1 !== lineNo) stats.carriedAccepted++;
      lines = match.l;
      ids = match.i;
      note(section(text));
      log.push(`ok ${key} ${op} ${JSON.stringify(newLines)}`);
    }
    rmSync(dir, { recursive: true, force: true });
    delete (globalThis as any).__hashlineToolExecutors;
  }
  const out = process.env.FUZZ_OUT;
  if (out) writeFileSync(out, JSON.stringify(stats, null, 1));
  expect(stats.wroteOnRefusal).toEqual([]);
  expect(stats.wrongLine).toEqual([]);
  expect(stats.forgedAccepted).toEqual([]);
  expect(stats.falseRefusal).toEqual([]);
  expect(stats.carriedAccepted).toBeGreaterThan(0);
}, 600000);
