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
