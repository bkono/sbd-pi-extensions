# @solvedbydev/pi-om-extension

Observational memory for Pi, ported from Mastra Code's OM (`@mastra/memory@1.41.0`, Apache-2.0).

Long sessions stay small and continuous. Background observer calls compress the conversation into dated observations. Finished observations swap into context without waiting on a model. The prompt cache only breaks when it would anyway.

## Behavior

| What | When |
|---|---|
| Background observation | every ~6k new message tokens (3k near the threshold), never on the critical path |
| Activation (swap observations in, drop covered messages) | at 30k pending tokens, mid-run or at run start; keeps ~2k raw |
| Cache-timed activation | at run start when idle time exceeds the model's prompt-cache lifetime, or the provider changed |
| Blocking observation | only at 60k pending tokens (the backstop) |
| Background reflection | from 20k observation tokens, swapped in at 40k, blocking only at 44k |
| Compaction | OM replaces Pi's summarizer; the native one runs only if OM is off |

The model sees memory as the `observational-memory` section of the system prompt. It can page raw history behind any observation group with the `om_recall` tool, instead of re-reading files.

## State

Nothing is written outside the session. OM state is `om.chunk`, `om.activation` and `om.reflection` custom entries on the active branch. Activations commit `context_edit` entries that omit the covered messages from model context. Raw history stays intact for `/tree`, export and recall. `/tree` and fork carry a consistent memory state.

## Models

There are no config files. The observer and reflector use the first model that has auth:

1. `openai-codex/gpt-6-luna`
2. `openai-codex/gpt-5.6-luna`
3. `anthropic/claude-haiku-5-5`
4. `anthropic/claude-haiku-4-5`

A failed call falls through to the next model. With none available, OM turns itself off and the footer says why.

## Environment

| Variable | Effect |
|---|---|
| `PI_OM_MODEL=provider/model` | try this model first |
| `PI_OM_DISABLE=1` | turn OM off |
| `PI_CACHE_RETENTION=long` | use the long prompt-cache lifetime for TTL activation (Pi's own setting) |

## Visibility

- **Footer.** Shows `OM 12.3k/30k · mem 8.1k/40k`, plus `observing…`, `reflecting…` or `⏳ …` while something blocks.
- **Transcript.** Each activation or reflection renders a one-line `◆ memory` / `◆ reflection` entry. Expand it to see the observations.
- **`/om`.** Status, models, cache TTL, and recent events with durations. `/om observations` prints active memory.

## Upstream sync

`src/upstream/` holds files vendored verbatim from `@mastra/memory`. To check the prompt text for drift against a newer release:

```sh
node scripts/upstream-diff.mjs <mastra>/packages/memory/src/processors/observational-memory
```

Design and decisions: [docs/mastra-om-v2-port.md](docs/mastra-om-v2-port.md).
