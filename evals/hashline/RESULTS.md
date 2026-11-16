# Hashline effectiveness: Pi (hashline) vs Pi (stock tools) vs Mastra Code

Run 2026-11-16. Raw per-run metrics: `results-2026-11-16/metrics.json`. Table: `results-2026-11-16/summary.md`.

## Verdict

On these tasks, hashline as implemented **costs tokens and buys nothing measurable for gpt-6.1-sol**.

- Correctness is identical. All 54 runs (3 arms × 6 tasks × 3 reps) pass every hidden grader and the full suite. Every `path:line` reference in the session summaries is accurate in every arm.
- Against stock Pi tools, with the same extensions, OM and model, hashline uses **+28% input tokens** (8.63M vs 6.73M), **+58% uncached** (1.04M vs 0.66M), and **+15% requests** (432 vs 377). It is cheaper on one task (T4 refactor, −12%).
- The failure hashline insures against never happened. Stock `oldText/newText` edits failed **0 of 118** times. Hashline edits failed 1 of 118, and that one was the read guard refusing an anchor that was still valid.
- Pi (either arm) is far cheaper than Mastra Code (MC uses 3.3× hashline's input tokens). That gap comes from MC's fixed per-request overhead (about 21k vs 4.6k tokens) and about 1.7× as many requests. Hashline does not explain it.

The OM line-anchor/stale-mask fix (955c4b4, eb761a5) works as designed. Payload diffs show **zero** mid-history rewrites caused by masks in any OM session.

## Setup

| | Mastra Code | Pi + hashline | Pi stock |
|---|---|---|---|
| Version | 0.50.0, host SDK in-process | 1.5.2, `--mode rpc` | 1.5.2, `--mode rpc` |
| Model | `openai/gpt-6.1-sol`, medium thinking | `openai-codex/gpt-6.1-sol`, medium | same |
| OM | native, observer/reflector gpt-6.1-terra (Bryan's settings) | pi-om (terra first), stock thresholds | same |
| File tools | view / string_replace_lsp / search_content / find_files | hashline read / edit / grep / ls / find / ast_search | Pi built-in read / edit / write / bash |
| Extensions | plugins, hooks, MCP off | om, files, answer, exa, minions, sbd-workflow, hashline | same set minus hashline |
| Context files | global instructions skipped | `--no-context-files --no-skills --no-mcp` | same |

Fairness decisions:

- **The sbd-workflow plugin is off in MC.** With it on, MC ran the whole sbd flow on every task (router, `sbd_set_predicate`, playbook, verifier gate). Pi does that only under `/skill:sbd`, so the plugin would have measured workflow overhead, not file tools.
- **OM thresholds are untouched in both harnesses.** T6 reaches activations by being a longer session, not by changing a setting.
- **Pi stock is the control.** It isolates hashline from every other Pi-vs-MC difference.

## Fixture and tasks

`fixture/` holds *tallyhub*: a 3.5k-line TypeScript order-pricing service on Node 25 with no dependencies. It has catalog, pricing engine (`engine.ts`, 746 lines), regions (615 lines), coupons, order lifecycle, inventory, API and reports, plus 34 visible tests. Two bugs are planted. Visible tests are green at baseline. Hidden graders live in `grading/`. Each grader fails on the fixture and passes on the reference solution (`reference-solutions.py`; T6 was validated the same way).

| Task | Shape | What it stresses |
|---|---|---|
| t1-explore | 5 questions, no edits | navigation, lines read |
| t2-bugfix | bulk double-discount, symptom report | locate in a large file, single edit |
| t3-feature | gift wrap across types, engine (4 sites), validation, serialize | many edits to one big file |
| t4-refactor | positional → options-object rename, 9 call sites, 6 files | many small cross-file edits |
| t5-marathon | 4 prompts, one session: tax bug, region caps, expose cap, `path:line` summary | re-editing the same regions across prompts |
| t6-long-session | t5 + CSV column + big read + move-and-condition edit near earlier edits | longer session, OM activations, stale reads |

## Results (mean of 3 reps)

| task | arm | input tok | uncached | reqs | reads | read lines | read chars | re-read redundant | re-read post-edit | edit errs | OM act | min |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| t1 | mc | 292.0k | 45.7k | 9.7 | 9.7 | 1.1k | 46.6k | 4.7 | 0 | 0 | 0 | 1.1 |
| t1 | hashline | 80.8k | 26.1k | 6 | 6 | 1.3k | 59.5k | 0 | 0 | 0 | 0 | 0.5 |
| t1 | stock | 69.9k | 24.5k | 5 | 6 | 2.1k | 67.1k | 0 | 0 | 0 | 0 | 0.5 |
| t2 | mc | 559.4k | 34.3k | 18.3 | 6 | 574 | 23.0k | 1 | 0 | 0 | 0 | 1.6 |
| t2 | hashline | 136.6k | 28.8k | 10 | 2 | 677 | 30.6k | 0 | 0 | 0 | 0 | 0.5 |
| t2 | stock | 77.8k | 15.4k | 8 | 2 | 494 | 17.9k | 0 | 0 | 0 | 0 | 0.5 |
| t3 | mc | 1491.3k | 71.1k | 39 | 10 | 1.3k | 54.8k | 2.7 | 0 | 0 | 5 | 4.4 |
| t3 | hashline | 355.7k | 44.4k | 16.3 | 7 | 1.4k | 60.2k | 0 | 0 | 0 | 0.7 | 1.6 |
| t3 | stock | 293.7k | 31.7k | 17.7 | 6 | 1.3k | 47.4k | 0 | 0 | 0 | 0 | 1.8 |
| t4 | mc | 499.7k | 49.8k | 17.7 | 6 | 365 | 15.1k | 1.3 | 0 | 0 | 0 | 1.8 |
| t4 | hashline | 105.8k | 22.2k | 11 | 1.3 | 296 | 13.6k | 0 | 0 | 0 | 0 | 1.2 |
| t4 | stock | 119.7k | 17.2k | 11.7 | 3.3 | 570 | 21.6k | 0 | 0 | 0 | 0 | 0.8 |
| t5 | mc | 2733.9k | 156.2k | 70 | 21 | 2.0k | 79.3k | 6.7 | 4.7 | 0 | 6 | 7.7 |
| t5 | hashline | 945.1k | 102.1k | 44.3 | 13.3 | 939 | 40.0k | 3.3 | 3.3 | 0.3 | 0.7 | 2.9 |
| t5 | stock | 693.6k | 54.6k | 34.7 | 10.3 | 1.0k | 34.2k | 1.7 | 1.7 | 0 | 0.3 | 2.9 |
| t6 | mc | 3785.5k | 191.4k | 97 | 22.7 | 2.2k | 82.7k | 6 | 7 | 0 | 8.3 | 9.4 |
| t6 | hashline | 1252.2k | 123.7k | 56.3 | 16.7 | 1.5k | 57.7k | 2.7 | 7.3 | 0 | 1 | 4.0 |
| t6 | stock | 987.9k | 76.8k | 48.7 | 12.7 | 1.5k | 44.3k | 1.3 | 4 | 0 | 0.7 | 3.8 |

Definitions:

- **Read lines and chars** count every read-tool result and bash `cat`/`sed`/`head` read of a repo file.
- A **redundant re-read** reads a file that has not changed since this agent last read it.
- A **post-edit re-read** reads a file this agent edited since its last read.
- **Uncached** is input minus provider-reported cached input.

Uncached is noisy. Codex sometimes misses the cache on a byte-identical prefix (seen in payload diffs), and pi-minions flips the system prompt (below). Total input is the steadier measure of context volume.

## How hashline changed the runs

### What helped

- **Targeted reads.** With anchored grep context, the agent often reads a window instead of the whole file. In T2 r1 it grepped, then read `engine.ts` offset 290 limit 76, against a full 746-line read on stock. Read lines are lower in T1 (−38%) and T4 (−48%), and lower overall (18.6k vs 21.2k).
- **Batched edits.** Multi-op `edit` calls average 4.5 ops in T3, against 3.9 for stock.
- **Cheap anchor refresh.** After an edit, the agent often refreshes anchors with a narrow `grep` instead of a full re-read.

### What hurt

1. **The edit result returns no anchors, and the read guard expires on any mutation.** `index.ts` `expireStaleReadTurns` drops the file's read state at the next request after any edit, and `edit` returns only `Edited X (n changes, +a -b lines)`. So every follow-up edit to the same file needs a fresh grep or read. Measured in T5 and T6: **3 anchor-refresh calls per session against 0.3–1.5 on stock**, and post-edit re-reads of 3.3 vs 1.7 (T5) and 7.3 vs 4.0 (T6). This is the main source of hashline's extra requests.
2. **The guard is stricter than the hash.** The smoke test and the one live refusal (T5 r3) both refused an anchor that still verified against the file. The agent re-read and re-sent the identical edit. Hash verification already proves the anchor is fresh, so the guard adds a round trip without adding safety when every anchor in the edit matches.
3. **A false reformat warning on most multi-op edits.** `hashline.ts:820-828` counts changed lines positionally, so an `insert_after` mid-file counts every later line as changed: "Edit changed 697 lines across 9 operations — verify no unintended reformatting" on a +12/−3 change. It fired 11 times per T5 session and 14–15 per T6 session, every one a false positive. It triggered a re-read twice. Mostly it is noise in context.
4. **Line-prefix overhead.** `LINE:HASH|` costs **42.2 chars per read line against 33.0 for stock (+28%)**, so fewer lines still cost more chars (785k vs 697k).
5. **Fixed prompt overhead.** Hashline's tool prompts add about **560–620 tokens to every request** (first request 4.58–4.73k vs 4.02–4.17k). That is about 30k tokens over a 50-request session.

### OM and the stale-mask fix

- In every hashline OM session, provider-payload diffs show **no mid-history item rewrites** except at OM activations. Every hashline-only cache drop traced to something else (below). The prefix-signal gate holds masks as intended.
- **With OM on, masks effectively never land.** No `[Stale read result…]` placeholder appeared in any captured payload. A stale read stays visible until the activation that would release its mask, and the activation then observes the read away. So in OM sessions, stale context is protected by the **edit guard** (tracker-based), not the mask. The guard held: no edit went through on a stale anchor, and line references stayed 100% accurate after activations.
- Activations: Pi activated OM about once per T6 session; MC activated 8–9 times on the same task (see side findings).

## Recommendations

In priority order, each reversible and measurable by re-running this eval:

1. **Return fresh anchors from `edit`** for the changed region ± 2–3 lines (`LINE:HASH|`), and mark those lines anchored in the read tracker. This removes most anchor-refresh calls and post-edit re-reads. It is the biggest lever, about 3 requests per multi-edit session.
2. **Let the hash be the guard.** When every anchor in an edit verifies against the current file, apply it even if the read-turn entry expired. Keep refusing on any hash mismatch and on anchorless edits to never-read files. This removes the identical-retry refusals.
3. **Fix the reformat warning.** Count changed lines from the real diff (`diff` is already a dependency), or drop the warning.
4. **Trim fixed overhead.** Audit hashline's `description`, `promptSnippet` and `promptGuidelines` across its 7 tools, roughly 600 tokens per request.
5. **Re-measure where hashline should win.** This model never failed a stock edit, so the next eval should target hashline's insurance case: a weaker or cheaper model, files with many near-duplicate lines (where `oldText` is ambiguous), and files over 2,000 lines (where maps and symbol reads matter). If hashline still doesn't win there, consider a hybrid: hashline `read`/`grep`/map plus plain `oldText` edits.

## Side findings (not hashline)

- **pi-minions busts the prompt cache.** Its `DELEGATION REMINDER: You have made N tool calls…` is appended to the system instructions after N tool calls and later removed. Each flip rewrites `instructions` and breaks the cache from there (seen in both Pi arms, 1–2 times per long session). Move the reminder into a message or keep it stable once shown.
- **Pi loses the cache at prompt boundaries.** It is a full miss at the second prompt of a session and partial at the third, in both Pi arms. Worth a look in pi-om (run-start handling of the previous request).
- **MC activates OM far more often.** On T6 it activated 8–9 times against about 1 for pi-om, with peak context about 51k vs 35k. MC re-reads more (T6: 16.7 reads after the first edit against 14.7 hashline and 10.3 stock). Worth a parity check in pi-om.

## Reproduce

```bash
node evals/hashline/harness/run-eval.mjs <outDir> --reps 3 --concurrency 8
node evals/hashline/harness/analyze.mjs <outDir>
```

Add `EVAL_PROBE=1` to dump every Pi provider payload (`trace/payloads/req-NNN.json`) for cache diffs. `gen-fixture-data.mjs` regenerates the fixture tables deterministically.
