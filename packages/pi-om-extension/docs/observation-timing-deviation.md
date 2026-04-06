# Observation Timing Deviation from OpenCode Reference

**Date:** 2026-04-04
**Status:** Active — monitor during integration testing

## What Changed

The pi extension triggers observation cycles at **different lifecycle points** than the opencode plugin.

### OpenCode Behavior (reference / battle-tested)

Observation cycles run in **two** places:

1. **`experimental.chat.messages.transform`** (before every LLM call)
   - Runs observation cycle with `excludeLatestMessage: true`
   - Then prunes messages to the unobserved window
   - Then injects observation context into the system prompt via `experimental.chat.system.transform`
   - System prompt injection happens **on the same call**, so observations and pruning are always in sync

2. **`session.idle`** (after processing completes)
   - Catch-up observation for anything missed

The critical property: **observations, pruning, and system prompt injection all happen atomically per LLM call**. If the observation cycle advances the cursor mid-loop, the system prompt injection on that same call reflects the new observations.

### Pi Extension Behavior (current)

Observation cycles run in **one** place:

1. **`agent_end`** (after the entire agent loop completes)
   - Runs observation cycle on the full message history
   - State is saved for the next agent loop

System prompt injection happens in **`before_agent_start`** (once, before the loop):
- Reads state, appends observation context to system prompt
- System prompt is **frozen** for the entire agent loop

Message pruning happens in **`context`** (before each LLM call):
- Reads state (same state that `before_agent_start` used)
- Prunes messages based on existing cursor
- Does **NOT** run observation cycles

### Why This Was Changed

Pi's `before_agent_start` event is the only clean way to modify the system prompt. It fires once per agent loop. The `context` event can only modify messages, not the system prompt.

If we ran observation cycles in `context` (like OpenCode does in `messages.transform`), a mid-loop observation could advance the cursor and prune messages that the frozen system prompt doesn't have observations for. The model would lose information about pruned messages.

Moving observation exclusively to `agent_end` guarantees the system prompt and pruning cursor are always derived from the same state snapshot.

### Behavioral Differences

| Scenario | OpenCode | Pi Extension |
|----------|----------|-------------|
| Short agent loop (1-2 turns) | Observation may trigger if threshold already near | No observation during loop; triggers after |
| Long agent loop (many tool calls, large output) | Observation triggers mid-loop when threshold hit; fresh observations immediately visible | Raw messages accumulate during loop; observation happens after loop ends |
| Context window pressure during long loop | Mitigated by mid-loop observation + pruning | Higher pressure — full message history stays until loop ends |
| Observation freshness per LLM call | Always current (observe + inject on same call) | Stale by up to one full agent loop |
| Compaction during loop | Observations always current before compaction | Forced observation in `session_before_compact` covers this case |

### Risks

1. **Context window overflow during long agent loops** — if an agent loop generates massive tool output (e.g., reading many files, long bash output), the unpruned messages could approach context limits before `agent_end` gets a chance to observe. OpenCode would have observed and pruned mid-loop.

2. **Observation staleness** — within a multi-turn agent loop, the model works with observations from before the loop started. In OpenCode, observations update per-turn. For most interactive use this is fine (loops are short), but automated/scheduled agents with long autonomous loops may notice.

### If We Need to Revert

To get back to OpenCode-equivalent behavior, we'd need to move observation context injection from `before_agent_start` back to per-call injection. Two approaches:

**A. User message injection with framing** — inject observation context as a user message in the `context` event with `[SYSTEM CONTEXT — NOT FROM USER]` wrapper. Allows per-call observation + injection. Risk: attribution confusion despite framing.

**B. `before_provider_request` payload mutation** — intercept the raw API payload and inject into the system prompt field. Allows per-call system prompt updates. Risk: provider-specific code, fragile across provider changes.

### Decision Rationale

The current approach prioritizes **correctness** (no drift between system prompt and cursor) over **freshness** (per-call observation updates). This is a defensible tradeoff for interactive use where agent loops are typically short. It may need revisiting for long-running autonomous agents (e.g., the pi-mom use case with extended tool chains).
