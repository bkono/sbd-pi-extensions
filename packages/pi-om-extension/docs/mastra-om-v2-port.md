# pi-om v2: port Mastra Code's OM mechanism to Pi

**Date:** 2026-11-11
**Status:** Decisions locked 2026-11-11 (see §11). Build in progress on `feat/pi-om-v2`.
**Reference:** `@mastra/memory@1.41.0` as shipped in `mastracode@0.49.0` (`@mastra/code-sdk@1.18.0`), source recovered from the installed sourcemaps. All three packages are Apache-2.0, so prompts and parsers can be copied with attribution.
**Our baseline:** `@solvedbydev/pi-om-extension@0.3.1` on Pi `1.3.0`.

## 1. Problem

Three things go wrong in pi-om today:

- Prompts stall for long, invisible stretches.
- Continuity breaks: the model loses its working set and re-reads files.
- The prompt cache breaks at the wrong points.

Mastra Code runs the same OM idea without these problems. This doc covers what differs, why theirs works, and what a rewrite on Pi 1.3 takes.

## 2. Root causes in pi-om 0.3.1

Each cause is labelled **measured**, **code** (read directly from the source) or **inferred**.

| # | Cause | Evidence |
|---|---|---|
| 1 | The observer runs **synchronously on the critical path**. The `context` hook awaits `runObservationCycle` before every LLM call (`src/index.ts:216`). The cycle loops chunks **sequentially** (`src/engine.ts:518`) and runs reflection inline (`src/engine.ts:585`). Each call has a 120s timeout. | code |
| 2 | **In-flight dedupe makes the next call wait.** If any cycle is in flight, including the previous turn's `agent_end` cycle, the next `context` call awaits it (`src/engine.ts:470`). This is the "hangs at the start of a prompt" case. | code, inferred for the user-visible effect |
| 3 | **Observer inputs are large.** Each call gets the *entire* existing observation log plus a chunk of up to 32k tokens, with full tool results and thinking blocks. Mastra sends about 1k tokens of prior observations plus a 6k slice (3k near the threshold), and caps each tool result at 5k tokens. | code |
| 4 | **The observer never sees tool arguments.** `serializeMessage` reads `toolCall.input`, but Pi 1.3 names the field `arguments`. A `read` of `src/auth.ts` serializes as `read input={}`. Observations cannot record which file, range or command was used. After pruning, the model re-reads. | **measured** (probe script, 2026-11-11) |
| 5 | **The threshold cliff.** Staging happens at 96k and publishing at 192k (clamped to about 55% of the window). Pruning moves only on publish, which happens at turn end. Raw context grows all turn, then collapses in one step. | **measured** from state files: `financy` went from 303,253 to 1,911 raw tokens (616 entries pruned, 22.5k observation tokens). `alfred-ts` went from 98,510 to 766. |
| 6 | **Double summarization near overflow.** Long turns hit Pi's native compaction mid-turn. `session_before_compact` forces OM over *everything* unobserved (several sequential 32k calls), then Pi runs its own summarizer. Two stop-the-world passes back to back. | code, inferred for frequency |
| 7 | **The cursor is timestamp-only.** `getMessageId` reads `message.id`, which Pi messages do not have. Every state file shows `lastCursorMode: "timestamp"`, and none shows `"id"`. Parallel tool results that share a millisecond can be skipped or double-counted. | **measured** (all inspected state files), inferred for the skip risk |
| 8 | **State writes are not atomic.** A plain `writeFile` (`src/state.ts:313`) is shared by concurrent `context` and `agent_end` handlers. The state file is keyed by session and is not branch-aware, so `/tree` and fork diverge from it. | code, inferred risk |
| 9 | **No visibility.** The only signal is `console.error` behind `OM_DEBUG`. Nothing reaches the TUI. | code |

Causes 4 and 5 interact. Dropped tool args made mid-turn pruning cause re-reads. The fix was to stop pruning mid-turn and raise thresholds. That turned every observation into a large blocking batch and created the cliff.

## 3. How Mastra Code's OM works

Mastra Code configures OM in `code-sdk/src/agents/memory.ts` and `constants.ts`:

```
observation.messageTokens   30_000   observe threshold
observation.bufferTokens    1/5      background observe every 6k (halves to 3k near threshold)
observation.bufferActivation 2_000   on activation keep only ~2k raw tokens
observation.blockAfter      2        only block (sync observe) at 60k
observation.previousObserverTokens 1_000   observer sees ~1k of prior obs (keeps 🔴/✅ lines)
reflection.observationTokens 40_000
reflection.bufferActivation  1/2     background reflect from 20k
reflection.blockAfter        1.1     only block at 44k
activateAfterIdle  'auto' (anthropic: cache TTL)   prune when the cache is cold anyway
activateOnProviderChange true
temporalMarkers true, retrieval true (recall tool), scope thread
```

The "70k" in their UI is the 30k + 40k total budget.

The pieces that make it work:

1. **Buffering runs in the background, observation does not block.** At each step, crossing a buffer interval seals the safe completed prefix (no dangling tool calls). Then it fires one observer call in the background on about 6k tokens (`observation-turn/step.ts:190-263`). The result is stored as a *buffered chunk*.
2. **Activation is a cheap swap.** Between the threshold (30k) and blockAfter (60k), a step activates ready chunks. It moves their observations into the active log and removes the covered messages from context. That costs no LLM call. Activation keeps about 2k raw tokens, and never removes messages the model has not read yet (by id, `inFlightIds`).
3. **Only one path blocks.** A synchronous observation runs only at or above blockAfter, or when buffering is off.
4. **Activation is timed for the cache.** At step 0, chunks activate when the threshold is crossed. They also activate when idle time exceeds the provider's cache TTL, because the cache is cold anyway and pruning costs nothing (`activation-ttl.ts`, `observational-memory.ts:3923`). Below that, the OM system message is byte-stable.
5. **Reflection also buffers.** The reflector starts at 50% of its threshold and swaps in at 40k. It blocks only at 44k.
6. **Observations are precise.** The observer sees tool args and results (each result capped at 5k tokens). Its prompt requires file and line ranges, grouping of repeated tool calls, and ✅ completion markers (`observer-agent.ts:230-390`).
7. **A recall tool covers what was pruned.** Observations carry group ids and source message ranges. `recall` pages raw history by cursor, so the model never has to re-read a file to recover pruned detail.
8. **One summarizer.** OM is the compaction. Nothing else competes with it.
9. **Visible progress.** `data-om-status`, buffering and activation parts drive a TUI block (`tui/components/om-output.ts`). That block is built on `@earendil-works/pi-tui`, the same library Pi uses.

## 4. The delta

| Concern | pi-om 0.3.1 | Mastra Code |
|---|---|---|
| Observe trigger | stage 96k / publish 192k (clamped) | 30k, with background slices every 6k |
| Observer call size | all prior obs + up to 32k msgs | ~1k prior obs + ~6k msgs |
| Who waits | every LLM call, every turn end, compaction | nobody until 60k |
| Pruning | at turn boundary, all at once | per step, a chunk at a time, keeps ~2k raw + unread |
| Cache policy | freeze per turn | stable until activation, activation timed for TTL expiry |
| Reflection | inline, synchronous at 120k | buffered from 20k, swap at 40k |
| Tool args to observer | lost (bug) | included |
| Re-read recovery | none | `recall` tool over raw history |
| Message identity | timestamp | message ids |
| Compaction | OM plus Pi native | OM only |
| UI | none | status and markers |

## 5. Pi 1.3 primitives that make a faithful port possible

Our `observation-timing-deviation.md` says parity was blocked on "a safe per-call publication mechanism". Pi has added one since then:

- **`context` plus `context_with_system`** run per LLM call. `context` prunes messages. `context_with_system` owns the full request, including system messages, and is request-local. Together they let OM update the injected block and the pruning in one call.
- **`ContextEditEntry`** (`appendContextEdit(id, null)`, or `context_edit` drafts from `turn_end`) omits an entry from future model context without touching raw history. It is branch-relative, so activation is durable and survives `/tree`.
- **Stable entry ids.** `turn_end` carries `messageEntryId` and `toolResultEntryIds`, and `getBranch()` entries have ids. This replaces the timestamp cursor.
- **Custom entries** (`appendEntry`) hold branch-aware OM records, chunks and generations in the session file, in place of `.pi/om-state/*.json`.
- **`model.promptCache`** lifetimes plus the last assistant timestamp drive `activateAfterIdle`. **`cache_warming_decision`** lets OM stop Pi from warming a cache it is about to invalidate.
- **`ctx.ui.setStatus` / `setWidget` / `registerMessageRenderer`** give visibility. Mastra's `om-output.ts` already targets pi-tui.

## 6. Recommendation: a native port of the mechanism, not an embedded library

**Rejected: embedding `@mastra/memory`.** Its `ObservationalMemory` class has a standalone API (`getStatus`, `buffer`, `activate`, `observe`, `reflect`, `buildContextSystemMessages`). Embedding it would still need:

- `@mastra/core`, which is 94 MB and gated on core features;
- a second message store;
- a bridge from pi-ai to the AI SDK so the observer can use the Codex OAuth model route;
- a rewrite of the step orchestration, which is built on Mastra's `MessageList` buckets, sealing and response-id rotation that Pi lacks.

The parts we would actually reuse are prompts, parsers and thresholds. Those are cheap to copy.

**Chosen: a new engine shaped like Mastra's.** Copy the prompt and parser files verbatim with attribution. Pin them to an upstream version, and add a script that diffs them against new `@mastra/memory` releases.

### Module map (new)

| Module | Source to port | Notes |
|---|---|---|
| `thresholds.ts` | `thresholds.ts` (185 lines) | Verbatim. |
| `buffer.ts` | `buffering-coordinator.ts` and the `buffer`/`activate`/`getStatus` parts of `observational-memory.ts` | Per-session, in-process. Persist chunks as custom entries. |
| `step.ts` | the `observation-turn/step.ts` decision tree | Driven from `context`. Must never block below blockAfter. |
| `observer/` | `observer-agent.ts` single-thread paths, `tool-result-helpers.ts`, `date-utils.ts`, `temporal-markers.ts` | Drop the multi-thread and resource-scope code. |
| `reflector/` | `reflector-agent.ts`, the core of `reflector-runner.ts` | Buffered reflection plus compression levels. |
| `format-pi.ts` | new | Pi `Message` to observer transcript: tool args, 5k result cap, no thinking, custom messages by renderer. |
| `store.ts` | new | Custom entries plus `context_edit` drafts at `turn_end`. |
| `recall.ts` | `tools/om-tools.ts` (thread-scope `messages` mode only) | Pages branch entries by id. |
| `ui.ts` | `tui/components/om-output.ts` | Footer status plus observation/reflection blocks. |

Size: about 4-5k lines including tests, inferred from the source sizes, which is close to today's 4.1k. Effort: 4-6 focused agent-days, a guess.

### What to delete from 0.3.1

- Draft/publish split and stage/publish thresholds.
- `window-budget.ts` clamp and `capPublishedObservationState`.
- `preserveNativeCompactionFloor`.
- `preservePreviousAssistantResponse`. Replaced by in-flight-id protection plus the retention floor.
- `temporal.ts` JSON observation entries. Replaced by Mastra's text format and date utils.
- File-based state.

## 7. Lessons that carry forward as tests, not hacks

1. **Tool-call pairs never split.** Use a safe-prefix selection, and run no threshold observation while a call is pending.
2. **Unread content is never pruned.** Protect it by message id, not by token heuristics. This replaces the "save that" previous-assistant hack.
3. **The observer sees what the model did.** A golden test serializes every Pi content type (`toolCall.arguments`, images, bash, custom messages, hashline/readmap compact output) and fails on `{}`.
4. **The cache is stable between activations.** N steps below threshold must produce a byte-identical system-plus-OM prefix.
5. **No hidden blocking.** With a fake observer that sleeps 30s, the `context` hook returns in under 50 ms below blockAfter.
6. **No cliff.** No single activation removes more than `threshold - retentionFloor` plus one chunk.
7. **Re-read rate.** In a scripted long task, duplicate reads of the same path and range after activation are no worse than Mastra Code on the same task.

## 8. One-way doors (need Bryan)

1. **Persistence format.** Recommend session custom entries plus `context_edit` over `.pi/om-state/*.json`, with **no migration**: old sessions start v2 empty. Undo cost: a format switch later means a migration.
2. **OM owns compaction.** Recommend OM bounds context (blockAfter 60k). Pi native compaction stays as an overflow fallback that should never fire, which telemetry verifies. Undo cost: low.
3. **Package identity.** Recommend a rewrite in place as `@solvedbydev/pi-om-extension@1.0.0`, with the old engine deleted rather than kept behind a flag. Undo cost: a revert.
4. **Defaults.** Recommend Mastra Code's numbers (30k/40k, 1/5, 2k, 2x, 1.1x) with the observer on the Codex route. Reversible, but it sets user-visible behavior.

## 9. Open questions a spike can settle

- Does a second system message from `context_with_system` keep Anthropic and Codex prompt caching intact? Or should OM render as the first user-role block? Measure `cacheRead` across 10 steps.
- Should activation persist as `context_edit` at `turn_end`, or stay request-local in `context`? This depends on whether Pi's compaction trigger reads provider usage or the session estimate.
- How large is observer latency on gpt-5.6-luna for a 6k slice? Measure p50 and p95 on 20 slices.

## 10. Proposed sequencing

0. **Hotfix 0.3.2, before the port.** Fix `toolCall.arguments` (cause 4), and drop thinking blocks and cap tool results in the serializer. Small, testable, and it stops the re-read bleed now.
1. Spike the open questions in §9.
2. Engine core: thresholds, buffer, activate, and the step state machine with fake observers. Tests 1, 2, 4, 5, 6.
3. Observer and reflector ports, plus the golden serializer test.
4. Store, recall tool and UI.
5. Live A/B against Mastra Code on one scripted task. Test 7 and latency telemetry.

## 11. Locked v2 design (Bryan, 2026-11-11)

Decisions:

- **D1** No migration. v2 starts with empty memory, and `.pi/om-state` is not read.
- **D2** OM owns compaction. Pi native compaction is an overflow fallback only.
- **D3** Rewrite in place as `@solvedbydev/pi-om-extension@1.0.0`. The old engine is deleted.
- **D4** Mastra Code's numbers, with no config files. Models resolve automatically.

### Storage: session entries plus context edits

All OM state lives in the Pi session file, on the active branch, as custom entries. Nothing is written elsewhere.

| customType | Written when | Holds |
|---|---|---|
| `om.chunk` | a background observer call finishes | chunk id, observation text, token counts, the covered entry ids, current-task, suggested-response |
| `om.activation` | buffered chunks are swapped into active memory | the activated chunk ids, the trigger (`threshold`, `ttl`, `provider_change`, `block`), and the resulting observation token count |
| `om.reflection` | a reflection is swapped in | generation number, the reflected observation text, and the chunk ids it folded |

Active memory is replayed from the branch: the latest `om.reflection` text, plus every chunk activated after it. Nothing duplicates the full text per activation.

Activation also emits one `context_edit` (`replacement: null`) per covered message entry. Pi then omits those messages from every future request. Pi's compaction accounting switches to a projection estimate once context edits exist (`agent-session.js:2451`), so its threshold sees the pruned size. Raw history stays in the session file for `/tree`, export and the recall tool.

Because entries and edits are branch-relative, `/tree` to an earlier point restores the OM state of that point. Fork carries it along.

Write path:

- Mid-run, everything goes out as `turn_end` / `agent_before_settle` boundary drafts (`custom` plus `context_edit`), in order, with entry ids from `event.context.contextEntries`.
- A background chunk that finishes while the session is idle is written with `pi.appendEntry`.
- Activation at the start of a run (threshold, cache TTL or provider change, before any boundary) prunes the first request locally in `context`. Its context edits are committed at that run's first `turn_end`.

### Request flow (Mastra `step.prepare` mapped to Pi)

**`context`, first request of a run.** Activate buffered chunks if one of these holds:

- pending tokens ≥ 30k;
- idle time ≥ the cache TTL;
- the provider changed.

Then check reflection: swap in a buffered reflection, block only at ≥ 44k, start a background reflection at ≥ 20k. Prune the activated entries locally.

**`turn_end`, after every step.** This is the mid-run path:

1. Compute status from `contextEntries`.
2. If a 6k interval is crossed (3k near the threshold), seal the safe prefix and start a background observer call.
3. In the 30k–60k band with a ready chunk, activate.
4. At ≥ 60k, wait (bounded) on in-flight buffering, activate, then observe synchronously. This is the only blocking path.
5. Emit the drafts.

**`agent_before_settle`.** Flush pending chunks. Buffer the remaining safe prefix while idle.

**`context_with_system`, every request.** Set the leading system message's `sections["observational-memory"]` from the active state. The block changes only on activation or reflection.

**`session_before_compact`.** Bring OM fully up to date. Return a compaction whose `firstKeptEntryId` is the first unobserved entry and whose summary is a pointer to observational memory. No second LLM summarizer.

### Models (D4)

The observer and reflector each take the first candidate that has configured auth (`modelRegistry.hasConfiguredAuth`):

1. `openai-codex/gpt-6-luna`
2. `openai-codex/gpt-5.6-luna`
3. `anthropic/claude-haiku-5-5`
4. `anthropic/claude-haiku-4-5`

If none is available, OM disables itself and the status line says so. The only explicit configuration is the env var `PI_OM_MODEL=provider/id`, which goes first in the list.

At runtime, an observer or reflector call that fails with a model error falls through to the next available candidate.

Calls go through `modelRegistry.streamSimple(...).result()`, which uses Pi's auth chain and streams, as Codex OAuth requires.

### Cache TTL

The TTL is the `model.promptCache` lifetime for the active retention tier. When that is unknown, it falls back to Mastra's `activation-ttl.ts` table.

Last activity is the latest assistant message or `usage` entry of kind `cache_warm`. Idle warming therefore counts as activity, and OM never breaks a cache Pi kept warm.

### Review fixes (2026-11-11, fresh-eyes review of 2666f34)

| # | Finding | Fix |
|---|---|---|
| 1 | A `!cmd` bash entry can't take a `context_edit`. Pi then rejects the whole boundary, including other extensions' drafts. | Only editable entries (`message` with user, assistant or toolResult role, plus `custom_message`) are observable. Edits are filtered to editable entries. |
| 2 | Aborted or errored tool calls held the safe prefix open forever. | Calls on `aborted` and `error` responses are ignored. Open calls become orphans once a new user or assistant message arrives (Mastra selectSafeBufferPrefix). |
| 3 | Losing model auth hid memory while its edits still hid raw history. | Missing models only stop new observer and reflector work. Existing memory is always injected. |
| 4 | Background results landed on the wrong branch after `/tree`. | A `session_tree` handler bumps an epoch and drops stale results and pending drafts. Chunks whose entries are not in context never activate. A buffered reflection checks its active-chunk basis. |
| 5 | Returning a list from `context` collapsed Pi's mid-transcript system messages. | All request edits (omission, reminder, OM section) moved to `context_with_system`. `context` only does run-start work. |
| 6 | A cancelled compaction could commit activations without edits. | Compaction honors `event.signal`. Activations wait for `session_compact`, or for the next boundary with their edits. |
| 7 | The "sent" heuristic treated unseen tool results as read. | Read status is structural: an entry is read if an assistant message follows it, or if it is assistant output itself. This survives restarts. |
| 8 | Blocking failures re-ran the whole model chain every turn. | Exponential backoff (60s up to 15m) on the buffer, block and sync-reflect paths. |
| 9-10 | messageKey collisions, stale token counts, section cache key. | Keys map to ordered id queues. The token cache is keyed by message object. The section cache is keyed by activated chunk ids. |

Verifier round 2 (on 5c10237): FAIL on a regression introduced by the fix for finding 4.

| # | Finding | Fix |
|---|---|---|
| R1 | Skipping a chunk with an out-of-context entry stranded its other entries. Pi's auto-retry `_omitRecoveryAttempt` triggers it. | A buffered chunk is live only while every entry it covers is in context. Otherwise it is stale, and its remaining entries are re-buffered. A regression test reproduces the retry sequence (red on 5c10237, green after). |
| R2 | A constant compaction summary made Pi's `session_compact` report the oldest compaction entry. | The summary includes the keep entry id, the generation and the activation count. |

Known and accepted:

- Pi's projected-token compaction estimate does not count the request-time OM section. It undercounts by at most the observation tokens (under 44k), against a fallback threshold that OM keeps unreachable.
- A `!cmd` bash entry stays raw in context permanently.

## 12. Parity audit against Mastra Code (2026-11-11, after the review rounds)

Sources:

- Mastra Code config: `@mastra/code-sdk@1.18.0` `agents/memory.ts`.
- Mastra defaults and runtime: `@mastra/memory@1.41.0`.

Evidence key: **L** = verified in a live Pi run; **T** = unit or regression test only.

### "Why Mastra Code works", item by item

| Claim | Status |
|---|---|
| 30k observe, 40k reflect, 6k buffer (3k near threshold), 60k block | L (buffers and threshold activations live), T (all thresholds) |
| Activation is free, keeps ~2k raw, never drops unread messages | L (activation 0ms), T (retention boundary math, structural read rule) |
| Timed for the cache: threshold, TTL, provider change | L (TTL on a backdated session), T (provider change) |
| Observations carry paths and line ranges | L (paths, offset and limit in tool args) |
| Observations group repeated tool calls and mark ✅ completions | Prompt verbatim; not specifically observed live |
| Recall instead of re-reading | L (`om_recall` answered two pruned-detail questions; 0 re-reads) |
| No competing summarizer | T plus reviewer probes; the live runs never reached compaction |
| Visible progress | L (Pi 1.3 TUI footer and `◆ memory` transcript entries) |

### Gaps found in this audit and closed (commits 79858d4, 0191d1f, fe9702b)

- **Extractor prompt.** Mastra Code's observer prompt comes from composed extractor sections (current-task, suggested-response, thread-title), not the legacy text. Vendored verbatim; the drift check passes 17/17.
- **temporalMarkers.** A `<system-reminder>` with gap text goes before any user message that follows 10 or more minutes of silence, and the observer transcript shows the same line. Derived from branch timestamps instead of persisted, so the request stays cache-stable (L).
- **threadTitle.** The observer's title becomes the Pi session name, unless the user named the session (L).
- **Reflection provenance.** `reconcileObservationGroupsFromReflection`, so recall ranges survive reflection (T).
- **Transient retries.** Same-model retries (1s, 4s) before failing over (T).
- **observeAttachments.** Images go to observers whose model accepts them, up to 8 per call (T).
- **Failover visibility.** A `failover` event plus a footer warning; it was silent before (L).
- **Pi version gate.** OM refuses to run on Pi below 0.87, where it would activate chunks without their edits (L on Pi 0.80.2).

### Intentional divergences

- **Model order.** Codex, then Anthropic, then `PI_OM_MODEL` first when set (Bryan, D4). Mastra Code uses Gemini first, then the main provider's cheap model.
- **Failure handling.** Short retries, then failover, then backoff; a failure never fails the user's turn. Mastra makes 8 retries over about 4 minutes, then aborts the turn (`failurePolicy` defaults to `abort`).
- **Blocking observation.** Parallel batches of about 12k, 4 at a time. Mastra makes one sync call.
- **Buffer interval.** Measured on unbuffered tokens, so no boundary needs persisting. Mastra persists a token boundary.
- **Buffered reflection slicing.** By whole chunks. Mastra slices by line count.
- **Recall.** Group range plus substring search. No vector search, no threads mode, no observation paging.
- **Compaction.** OM replaces Pi's compaction. Mastra Code has no compaction to replace.
- **Not ported:** tool-argument outline formatter (simplified), observer temperature (reasoning `low` instead), `generateTitle` on the first message, caveman mode, per-thread threshold overrides. There is no config by design.

### Cache evidence (L, Codex gpt-6.1-sol)

- **Append-only between activations.** A prefix probe on every provider request showed `instructions` and `tools` byte-identical and the input array strictly extending the previous one, on every non-activation request.
- **Activation is the only change.** Only the activation request changes `instructions` (the OM section) and the input (pruned, with the reminder).
- **Reuse.** Cache reuse of the previous request was 95-100% everywhere except the activation request.
- **Sporadic misses.** An A/B (3 runs with OM on, 3 with OM disabled) showed sporadic single-request misses only with OM on. One of them came before OM had done any work. They are attributed to Codex-side variance; this is inferred.
- **Anthropic.** Not measured.

### Still open

- **Re-read A/B against Mastra Code is inconclusive.** Mastra Code's `view` tool caps reads at about 2k tokens, so the same task never crossed its threshold. The local Mastra Code OM is configured for Gemini and returns 402 on every observation.
- **Not exercised live:** reflection and the OM compaction path (tests and reviewer probes only).

## 13. Live A/B against Mastra Code (2026-11-11)

Setup:

- Mastra Code 0.49.0, observer and reflector pinned to `openai/gpt-6-luna`. With Google credentials present, "auto" prefers Gemini, which returned 402 here.
- Pi v2 on Pi 1.3.0.
- Main model `gpt-6.1-sol` (low thinking) on both.
- Fixture: 14 generated files, about 62k tokens.

### Findings and fixes

| Finding | Evidence | Fix |
|---|---|---|
| Buffered observers never saw earlier buffered chunks, so every chunk before the first activation was blind to the task and the progress. After each activation the agent restarted from the first file. | 42-page counting task: v2 made 82 and 84 calls (40 and 42 duplicate reads); Mastra Code made 42 calls (0 duplicates); OM off made 42 calls (0 duplicates). | Ported `combineObservationsForBuffering` (674934d): duplicates fell to 5 and 10, all end-of-task verification reads. |
| The run's request is pruned mid-task (a Mastra rule), and the model then stops at "ok" on a "reply only ok after each page" task. | Both v2 and Mastra Code stopped right after activation; OM off completed (2/2). | The latest user message stays raw (281e9c4). The stop on that particular task persists in v2 and in Mastra Code. The prompt design invites it, and the counting task is unaffected. |
| Buffered prompts asked for current-task and suggested-response, which Mastra skips. | A suggestion "Read X, then reply only `ok`" preceded a stop. | Exact per-path prompts (c851956). |
| Forced `reasoning: "low"` on the observer. | Not the cause of the re-reads (no change measured). | Provider default restored for parity. |

### Fidelity

Truth: 100. Mastra Code answered 97: its observer miscounted `cache.ts` (2 against 5). v2 answered 100 and 82. Both systems lose some precision through observation. That is inherent to OM, and `om_recall` is the recovery path.

### Not equivalent between the two

Mastra Code's `view` tool caps a read at about 2k tokens. That tool-layer cap, separate from OM, makes Mastra Code's context grow more slowly. Pi's analogue is `pi-hashline-readmap`.

## 14. Accuracy on exact-aggregation work (2026-11-11)

Task: count the `acc * 7` step functions over 42 pages, about 62k tokens. Truth is 100. Main model `gpt-6.1-sol`; observer `gpt-6-luna` at medium on both systems.

### Where the errors come from

Every per-file error traces to an observation:

- The observer withholds a value because it reads the user's "do not answer until…" as a rule for itself.
- It labels a partial page count as the file total.
- It miscounts within a page.

The main model keeps no tally of its own, so after pruning the observer is the only counter. Errors cluster on early files, which are observed first and split across chunk boundaries.

### Measurements

| Config | Totals | Wrong files per run | Duplicate reads |
|---|---|---|---|
| OM off | 100 | 0 | 0 |
| v2 at c5c0ffc (Mastra-parity prompts) | 100, 95, 100, 100, 94 | 0-3 | 0-36 |
| Mastra Code | 97, 100, 86 | 1, 0, 4 | 0, 43, 6 |
| + observer guard (record per-page values) | 99, 98, 95, 101 | 5, 2, 4, 3 | 0-2 |
| + "verify exact values with om_recall" | 100, 99, 99, 95 | 0, 1, 1, 2 | 39-48 |
| + "state running tallies in your replies" | 95, 94, 83, 102 | 3, 2, 6, 2 | 3-31 |

### Conclusion

There is a tradeoff inherent to OM, and Mastra Code has it too. When observations carry values, the agent trusts them and inherits observer error. When they don't, the agent re-reads and counts correctly.

No prompt-level remedy improved both accuracy and re-reads, so all three were reverted and the code stays at Mastra parity.

Next levers:

1. A stronger observer, for example `gpt-6.1-terra` at medium. Bryan reports good results with it in Mastra Code.
2. Agent behavior that writes intermediate results into its own messages from the start.

This benchmark is adversarial: exact aggregation over raw data, with an agent that writes no text. On ordinary coding continuity (paths, decisions, specific values), fidelity was 28/28, and recall answers were exact.

### Observer model (2026-11-11, Pi 1.5.2)

| Observer | System | Runs | Totals | Wrong files | Duplicate reads |
|---|---|---|---|---|---|
| `gpt-6.1-terra` (medium) | v2 | 4 | 100 ×4 | 0 | 0 |
| `gpt-6.1-terra` (medium) | Mastra Code | 3 | 100 ×3 | 0 | 0 |
| `gpt-6-luna` (medium) | v2 | 5 | 94–100 | 0–3 | 0–36 |
| `gpt-6-luna` (medium) | Mastra Code | 3 | 86, 97, 100 | 0–4 | 0–43 |

The accuracy cap was the observer model, not the implementation. The two implementations behave identically per model.

Terra was also faster in the background: about 4s at p50 per buffer, against 7–8s for luna. It is now the first auto candidate. Pi releases whose catalog lacks it fall through to luna.

Mastra Code's own auto pick is luna. Bryan uses terra in Mastra Code.
