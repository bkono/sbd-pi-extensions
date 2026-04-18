# Observation Timing Deviation from OpenCode Reference

**Date:** 2026-04-18
**Status:** Active — staged mid-loop observation enabled

## What Changed

The pi extension now performs **incremental staged observation during long runs** while keeping the **public injected observation block and pruning cursor frozen until the run finishes**.

This is intentionally different from both:

- the earlier pi behavior, which only observed at `agent_end`, and
- the OpenCode / Mastra reference, which can observe and publish mid-loop on the same call.

## OpenCode Behavior (reference / battle-tested)

Observation cycles run in **two** places:

1. **`experimental.chat.messages.transform`** (before every LLM call)
   - Runs observation cycle with `excludeLatestMessage: true`
   - Prunes messages to the unobserved window
   - Injects observation context into the system prompt via `experimental.chat.system.transform`
   - Observation, pruning, and prompt injection are all updated on the same call

2. **`session.idle`** (after processing completes)
   - Catch-up observation for anything missed

Critical property: **if OpenCode advances the cursor mid-loop, the same call also publishes the new observations into the prompt**.

## Pi Extension Behavior (current)

Observation work is now split into **draft** and **published** state.

### 1. `before_agent_start` — inject published observations only

Before the agent loop starts, the extension:

- loads session state
- builds the observation appendix from **published** fields only
- appends that block to the system prompt once for the whole loop

The system prompt is therefore still **frozen for the duration of the loop**.

### 2. `context` — stage observations incrementally, but do not publish

Before each LLM call, the extension may run an observation cycle against the full branch:

- uses the **draft cursor** to find newly unobserved messages
- stages observations into `draftObservations`, `draftCurrentTask`, `draftSuggestedResponse`
- advances only the **draft** cursor
- uses `excludeLatestMessage: true` so the freshest message remains raw

But message pruning still reads **published** cursor state only:

- `lastObservedEntryId`
- `lastObservedTimestamp`

So even if draft observation advances mid-loop, the extension does **not**:

- mutate the public system prompt mid-turn
- publish staged observations mid-turn
- prune raw context based on the draft cursor

### 3. `agent_end` — final pass and turn-boundary publication

After the loop completes, the extension runs a final observation cycle on the full branch:

- catches anything still left outside the draft cursor
- evaluates publish thresholds against the staged-vs-published gap
- publishes the staged draft into the durable public fields when ready

Those published observations are then visible on the **next** `before_agent_start`.

### 4. `session_before_compact` — force final publication before compaction

Before compaction, the extension still forces a final observation pass so compaction summaries include the latest published OM state.

## Why This Was Changed

The earlier pi-only `agent_end` approach preserved correctness, but long autonomous runs could accumulate a very large raw tail before the observer ever saw it.

The new design aims for:

> **observe continuously, publish discretely**

That gives us most of the quality benefit of smaller incremental observations without the failure mode of mid-turn prompt swaps.

## Key Invariant

The most important rule is:

> **published prompt state and pruning state must stay aligned for the duration of a turn**

So the extension now allows this:

- **draft state may advance mid-turn**

but still forbids this:

- **published state advancing mid-turn**
- **pruning based on draft state mid-turn**

This keeps raw context available to the model even while background/incremental observation is happening.

## Behavioral Differences

| Scenario | OpenCode | Pi extension |
|----------|----------|--------------|
| Long agent loop crosses observation threshold | Observe + publish mid-loop on the same call | Observe mid-loop into **draft** only |
| Mid-loop system prompt | Updated immediately | Frozen until next turn |
| Mid-loop pruning cursor | Advances with published observation | Stays on **published** cursor only |
| Raw context after staged observation | May be replaced by newly published memory on later calls | Remains available because pruning ignores draft cursor |
| End-of-turn behavior | Usually small catch-up | Final catch-up + publish staged draft |

## Risks / Tradeoffs

1. **Extra observation latency/cost during long loops** — we now do real observation work during `context`, so threshold crossings can add work before some calls.
2. **Draft/public mismatch is intentional** — diagnostics may show draft state ahead of published state until the turn finishes.
3. **Still not full OpenCode parity** — the model does not see new observations until the next turn, by design.

## Decision Rationale

This is the intended compromise for pi:

- gain incremental observation quality during long runs
- keep raw context available mid-turn
- avoid public prompt mutation mid-loop
- avoid pruning drift ahead of what the prompt has actually published

If we ever want true OpenCode-equivalent behavior, pi would need a safe per-call publication mechanism that can update prompt injection and pruning atomically on the same request.
