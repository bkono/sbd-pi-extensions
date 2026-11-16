# Hashline effectiveness: Pi (hashline) vs Pi (stock tools) vs Mastra Code

Run 2026-11-16. Raw per-run metrics: `results-2026-11-16/metrics.json` (paths scrubbed). Table: `results-2026-11-16/summary.md`. An independent verifier gave the eval PASS+NOTES at 7b4ff29. Its metric notes are fixed here, and the numbers below are regenerated from the same traces.

## Verdict

On these tasks, hashline as implemented **costs tokens and buys nothing measurable for gpt-6.1-sol**.

- Correctness is identical. All 54 runs (3 arms × 6 tasks × 3 reps) pass every hidden grader and the full suite. Every `path:line` reference in the session summaries lands within ±4 lines of a changed hunk, in every arm.
- Against stock Pi tools, with the same extensions, OM and model, hashline uses:
  - **+28% input tokens** (8.63M vs 6.73M);
  - **+58% uncached** (1.04M vs 0.66M);
  - **+15% requests** (432 vs 377);
  - **+8% to +16% file-context chars**, read plus search output (938k vs 810k to 869k). The range is because 16 of stock's bash calls mixed search output with test or git output; the analyzer leaves those out, so +16% is the upper bound.

  It is cheaper on one task (T4 refactor, −12% tokens).
- The failure hashline insures against never happened. Stock `oldText/newText` edits failed **0 of 118** times. Hashline edits failed 1 of 118, and that one was the read guard refusing an anchor that was still valid.
- Pi (either arm) is far cheaper than Mastra Code (MC uses 3.3× hashline's input tokens). That gap comes from MC's fixed per-request overhead (about 21k vs 4.6k tokens) and about 1.7× as many requests. Hashline does not explain it.

The OM line-anchor/stale-mask fix (955c4b4, eb761a5) works as designed. Payload diffs show **zero** mid-history rewrites caused by masks in any OM session.

## Setup

| | Mastra Code | Pi + hashline | Pi stock |
|---|---|---|---|
| Version | 0.50.0, host SDK in-process | 1.5.2, `--mode rpc` | 1.5.2, `--mode rpc` |
| Model | `openai/gpt-6.1-sol`, medium thinking | `openai-codex/gpt-6.1-sol`, medium | same |
| OM | native, observer/reflector gpt-6.1-terra (Bryan's settings) | pi-om (terra first), stock thresholds | same |
| File tools | view / string_replace_lsp / search_content / find_files | hashline read / edit / grep / ls / find / ast_search | Pi defaults: read / edit / write / bash |
| Extensions | plugins, hooks, MCP off | om, files, answer, exa, minions, sbd-workflow, hashline | same set minus hashline |
| Context files | global instructions skipped | `--no-context-files --no-skills --no-mcp` | same |

Fairness decisions:

- **The sbd-workflow plugin is off in MC.** With it on, MC ran the whole sbd flow on every task (router, `sbd_set_predicate`, playbook, verifier gate). Pi does that only under `/skill:sbd`, so the plugin would have measured workflow overhead, not file tools.
- **OM thresholds are untouched in both harnesses.** T6 reaches activations by being a longer session, not by changing a setting.
- **Pi stock is the control.** It isolates hashline from every other Pi-vs-MC difference.
- **Provenance.** The 2026-11-16 runs loaded extensions from the live main checkout, which was at 649cf03 when the session started. Traces from then do not record the SHA. 649cf03 and 2e3f7b4 differ only in pi-minions. `pi-run.mjs` now records the extension root's SHA and dirty state in every trace.

## Fixture and tasks

`fixture/` holds *tallyhub*: a 3.5k-line TypeScript order-pricing service on Node 25 with no dependencies. It has catalog, pricing engine (`engine.ts`, 745 lines), regions (615 lines), coupons, order lifecycle, inventory, API and reports, plus 34 visible tests. Two bugs are planted. Visible tests are green at baseline. Hidden graders live in `grading/`. Each grader fails on the fixture and passes on its reference in `reference-solutions.py`, which covers T2 through T6.

| Task | Shape | What it stresses |
|---|---|---|
| t1-explore | 5 questions, no edits | navigation, lines read |
| t2-bugfix | bulk double-discount, symptom report | locate in a large file, single edit |
| t3-feature | gift wrap across types, engine (4 sites), validation, serialize | many edits to one big file |
| t4-refactor | positional → options-object rename, 9 call sites, 6 files | many small cross-file edits |
| t5-marathon | 4 prompts, one session: tax bug, region caps, expose cap, `path:line` summary | re-editing the same regions across prompts |
| t6-long-session | t5 + CSV column + big read + move-and-condition edit near earlier edits | longer session, OM activations, stale reads |

## Results (mean of 3 reps)

| task | arm | input tok | uncached | reqs | reads | read lines | file-context chars | redundant re-reads (lines) | post-edit re-reads | edit errs | cache drops | OM act | min |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| t1 | mc | 292.0k | 45.7k | 9.7 | 9.7 | 1.1k | 55.9k | 0.7 (7.7) | 0 | 0 | 0.3 | 0 | 1.1 |
| t1 | hashline | 80.8k | 26.1k | 6 | 6 | 1.3k | 61.0k | 0 (0) | 0 | 0 | 0 | 0 | 0.5 |
| t1 | stock | 69.9k | 24.5k | 5 | 6 | 2.1k | 67.6k | 0 (0) | 0 | 0 | 0 | 0 | 0.5 |
| t2 | mc | 559.4k | 34.3k | 18.3 | 6 | 574 | 29.5k | 0 (0) | 0 | 0 | 0 | 0 | 1.6 |
| t2 | hashline | 136.6k | 28.8k | 10 | 2 | 677 | 36.3k | 0 (0) | 0 | 0 | 0.3 | 0 | 0.5 |
| t2 | stock | 77.8k | 15.4k | 8 | 2 | 494 | 22.5k | 0 (0) | 0 | 0 | 0 | 0 | 0.5 |
| t3 | mc | 1491.3k | 71.1k | 39 | 10 | 1.3k | 55.3k | 1 (9.3) | 0 | 0 | 0.3 | 5 | 4.4 |
| t3 | hashline | 355.7k | 44.4k | 16.3 | 7 | 1.4k | 61.0k | 0 (0) | 0 | 0 | 0.3 | 0.7 | 1.6 |
| t3 | stock | 293.7k | 31.7k | 17.7 | 6 | 1.3k | 49.6k | 0 (0) | 0 | 0 | 0.3 | 0 | 1.8 |
| t4 | mc | 499.7k | 49.8k | 17.7 | 6 | 365 | 17.8k | 0 (0) | 0 | 0 | 0.7 | 0 | 1.8 |
| t4 | hashline | 105.8k | 22.2k | 11 | 1.3 | 296 | 15.6k | 0 (0) | 0 | 0 | 0.3 | 0 | 1.2 |
| t4 | stock | 119.7k | 17.2k | 11.7 | 3.3 | 570 | 23.5k | 0 (0) | 0 | 0 | 0 | 0 | 0.8 |
| t5 | mc | 2733.9k | 156.2k | 70 | 21 | 2.0k | 108.5k | 2 (29.3) | 4.7 | 0 | 1 | 6 | 7.7 |
| t5 | hashline | 945.1k | 102.1k | 44.3 | 13.3 | 939 | 55.0k | 1 (4) | 3.3 | 0.3 | 2.7 | 0.7 | 2.9 |
| t5 | stock | 693.6k | 54.6k | 34.7 | 10.3 | 1.0k | 48.2k | 0 (0) | 1.7 | 0 | 1 | 0.3 | 2.9 |
| t6 | mc | 3785.5k | 191.4k | 97 | 22.7 | 2.2k | 109.8k | 1.7 (6.3) | 7 | 0 | 2 | 8.3 | 9.4 |
| t6 | hashline | 1252.2k | 123.7k | 56.3 | 16.7 | 1.5k | 83.8k | 0 (0) | 7.3 | 0 | 2.3 | 1 | 4.0 |
| t6 | stock | 987.9k | 76.8k | 48.7 | 12.7 | 1.5k | 58.5k | 0 (0) | 4 | 0 | 1.7 | 0.7 | 3.8 |

Totals over 18 runs per arm:

| arm | input tok | uncached | requests | read chars | search chars | read lines | chars/read line | edits | edit errors |
|---|---|---|---|---|---|---|---|---|---|
| Pi + hashline | 8.63M | 1.04M | 432 | 785k | 153k | 18.6k | 42.2 | 118 | 1 |
| Pi stock | 6.73M | 0.66M | 377 | 697k | 112k | 21.2k | 33.0 | 118 | 0 |
| Mastra Code | 28.09M | 1.65M | 755 | 905k | 226k | 23.0k | 39.4 | 258 | 0 |

Definitions:

- **Read lines and chars** count read-tool results and bash `cat`/`sed`/`head` reads of repo files.
- **Search chars** count grep, find and ls tools plus bash `rg`/`grep`/`find`/`ls` output.
- **File-context chars** are read plus search.
- A **redundant re-read** returns lines this agent already saw in a file that has not changed since. A re-read of a new window of an unchanged file is not redundant.
- A **post-edit re-read** reads a file this agent edited since its last read.
- A **cache drop** is a request whose cached input falls below half the previous request's input, while the input did not shrink (so OM activations and compactions are excluded).
- **Uncached** is input minus provider-reported cached input. It is noisy: Codex sometimes misses the cache on a byte-identical prefix, and the pi-minions reminder flipped the system prompt (fixed since).
- **Why fewer lines but more chars:** each hashline read line carries a `LINE:HASH|` prefix, 42.2 vs 33.0 chars per line (+28%). Hashline read 12% fewer lines but 13% more read chars.

## How hashline changed the runs

### What helped

- **Targeted reads.** With anchored grep context, the agent often reads a window instead of the whole file. In T2 r1 it grepped, then read `engine.ts` offset 290 limit 76, against a full read on stock. Read lines are lower in T1 (−38%) and T4 (−48%).
- **Batched edits.** Multi-op `edit` calls average 4.5 ops in T3, against 3.9 for stock.
- **Cheap anchor refresh.** After an edit, the agent often refreshes anchors with a narrow `grep` instead of a full re-read.

### What hurt

1. **The edit result returns no anchors, and the read guard expires on any mutation.** `index.ts` `expireStaleReadTurns` drops the file's read state at the next request after any edit, and `edit` returns only `Edited X (n changes, +a -b lines)`. So every follow-up edit to the same file needs a fresh grep or read. Measured: **post-edit re-reads 32 vs 17** over all runs, and about 3 anchor-refresh calls per T5/T6 session against 0.3–1.5 for stock. This is the main source of hashline's extra requests. Truly redundant re-reads are negligible in both Pi arms (hashline: 3 reads, 12 lines total).
2. **The guard is stricter than the hash.** The one live refusal (T5 r3), and one in the smoke test, refused an anchor that still verified against the file. The agent re-read and re-sent the identical edit.
3. **A false reformat warning on most multi-op edits.** `hashline.ts:820-828` counts changed lines positionally, so an `insert_after` mid-file counts every later line as changed. It fired 11 times per T5 session and 14–15 per T6 session, every one a false positive.
4. **Line-prefix overhead.** It costs +28% chars per read line, as above.
5. **Fixed prompt overhead.** Hashline's tool definitions add about **560–620 tokens to every request** (first request 4.58–4.73k vs 4.02–4.17k).

### OM and the stale-mask fix

- In every hashline OM session, provider-payload diffs show **no mid-history item rewrites** except at OM activations. The prefix-signal gate holds masks as intended.
- **With OM on, masks effectively never land.** No `[Stale read result…]` placeholder appeared in any captured payload. A stale read stays visible until the activation that would release its mask, and the activation then observes the read away. In OM sessions, stale context is protected by the **edit guard** (tracker-based), not the mask. The guard held: no edit went through on a stale anchor.
- What masks still do under OM: they cover a stale read that survives a prefix move without being observed. Pi compaction, a model switch, and stale results the provider has not seen yet (masked at once) are the cases. None occurred here, and they cost nothing while held.

## Follow-up findings (2026-11-16, after the first report)

- **Can anchors match while the content changed? Yes**, so the guard stays.
  - `computeLineHash` (`hashline.ts:103`) hashes only the anchored line's text, whitespace-stripped, into 12 bits, and ignores the line number.
  - A `}` or blank line that shifted into line N verifies as the old one.
  - Indentation-only changes verify.
  - ±window auto-relocation and fuzzy relocation can rebind a stale anchor to a nearby line with the same hash.
  - `replace_lines` checks only its two end anchors.

  The fix for the identical-retry refusal is anchor-level freshness (sbdpi-cdf), not relaxing the guard.
- **Prompt-boundary cache loss was pi-minions, not Pi.** The delegation reminder entered the system prompt via `before_agent_start` at the start of the second prompt (full cache miss) and left at the third (about 40% lost). With the reminder removed (`claude/minions-drop-delegation-reminder`), live T5 runs show:
  - zero instruction changes across a whole stock session;
  - 98–100% of the prefix cached at every prompt boundary;
  - session cache hit 95–96%, against 87–93% before.

## Recommendations and decisions

| # | Item | Decision |
|---|---|---|
| 1 | `edit` returns fresh `LINE:HASH` anchors for each changed region ± a few lines; track freshness per anchor issued since the last mutation | queued: sbdpi-cdf |
| 2 | Let the hash alone be the guard | rejected: anchors can match stale content (above); folded into #1 |
| 3 | Drop the reformat warning | queued: sbdpi-lno |
| 4 | Trim tool definitions | candidates below; not started |
| 5 | Weaker-model test | dropped. Re-run this eval after #1/#3, and study hashline reads with plain `oldText` edits |
| — | Remove the pi-minions delegation reminder | done on its own branch |
| — | MC activates OM about 8× more than pi-om on T6 | queued: sbdpi-64e |

### #4: what to trim (usage across the 18 hashline runs)

The 8 tool definitions total about 1.8k tokens, mostly JSON schema (`edit` 1,778 chars, `find` 976, `grep` 871).

| Candidate | Usage observed | Proposal |
|---|---|---|
| `edit`: legacy top-level `{old_text,new_text}` variant ("Do not use") | 0 | remove from schema; keep accepting at runtime |
| `edit`: `insert_after.text` alias, `postEditVerify` flag, `additionalProperties: true` on every branch | 0 | remove from schema |
| `edit`: `replace_symbol` | 0 | keep only if large-file evals show use; otherwise move to a doc line |
| `edit`: `replace` (text) | 0 | keep; it is the anchorless escape hatch |
| `find`: size/date/sort/regex filters | 0 (8 calls used only `pattern`, `path`) | keep `pattern`, `path`, `limit`, `type` |
| `grep`: `scope`, `scopeContext`, `summary`, `literal`, `glob` | 0 | keep `pattern`, `path`, `context`, `limit`, `ignoreCase`; one line on advanced options |
| `ast_search` | 0 calls | register on demand, or fold into a `grep` mode |
| `read`: `map`, `symbol` | 0 and 1 | keep (large-file value); shorten their descriptions |

Used ops (`insert_after` 180, `set_line` 83, `replace_lines` 13; read `offset/limit` 96) stay untouched. The expected saving is about 500–700 tokens per request, bringing hashline near stock's fixed cost. Confirm by re-running this eval.

## Reproduce

```bash
node evals/hashline/harness/run-eval.mjs <outDir> --reps 3 --concurrency 8
node evals/hashline/harness/analyze.mjs <outDir>
```

- `EVAL_PI_EXT_ROOT=<checkout>` loads extensions from another checkout.
- `EVAL_PROBE=1` dumps every Pi provider payload to `trace/payloads/req-NNN.json`.
- `MC_HOST_NODE_MODULES` overrides the Mastra Code install found on PATH.
- `gen-fixture-data.mjs` regenerates the fixture tables deterministically.
