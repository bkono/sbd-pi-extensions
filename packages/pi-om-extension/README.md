# @solvedbydev/pi-om-extension

A [pi coding-agent](https://github.com/badlogic/pi-mono) extension implementing [Mastra-inspired observational memory](https://mastra.ai/docs/memory/observational-memory). Compresses raw conversation history into dense observations via an observer/reflector pattern, letting agents maintain continuity across long-running sessions and compaction boundaries with zero vector DBs or knowledge graphs.

This is a port of [`@solvedbydev/opencode-observational-memory`](https://github.com/bkono/opencode-observational-memory) to pi's extension system. See [Differences from the OpenCode version](#differences-from-the-opencode-version) for what changed and why.

## Quick Start

### Install (monorepo workspace)

This package is part of the sbd-pi-extensions workspace. To use it from another package in the workspace:

```json
// your-package/package.json
{
  "dependencies": {
    "@solvedbydev/pi-om-extension": "*"
  }
}
```

### Register with pi

Load via pi's extension system. Two options:

**(a) Inline factory** (programmatic, e.g. when using the pi SDK directly):

```ts
import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import piObservationalMemory from "@solvedbydev/pi-om-extension";

const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  extensionFactories: [piObservationalMemory],
});
await resourceLoader.reload();

const { session } = await createAgentSession({ resourceLoader /* ... */ });
await session.bindExtensions({});
```

**(b) From a file path** via `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/sbd-pi-extensions/packages/pi-om-extension/src/index.ts"]
}
```

### Auth

The observer and reflector use pi's standard auth chain. Configure credentials for your chosen provider in `~/.pi/agent/auth.json` (via `pi` CLI's `/login` flow) or via environment variables. No separate API key env var is needed — whatever pi's own agent uses, the extension uses.

That's it. The extension runs automatically once loaded.

## How It Works

The extension hooks into pi's lifecycle to maintain a persistent memory layer:

1. **Observe** — After an agent loop finishes, if unobserved message tokens exceed a threshold (default: 70k), an observer agent extracts key facts, decisions, and context from new messages.
2. **Reflect** — If accumulated observation tokens exceed a second threshold (default: 50k), a reflector agent consolidates observations, removing redundancy while preserving meaning.
3. **Inject** — On the next user prompt, observations are appended to the system prompt. Raw message history is pruned to only the unobserved tail, giving the LLM continuity without carrying the full conversation.

```
agent_end
  |
  +-- unobserved tokens >= threshold?
  |     yes -> Observer extracts observations
  |             |
  |             +-- observation tokens >= threshold?
  |                   yes -> Reflector consolidates
  |
  +-- state persisted to disk

next turn: before_agent_start
  |
  +-- observations appended to system prompt
  +-- continuation reminder added as system-reminder

next turn: context
  |
  +-- messages pruned to unobserved window
```

### Observer / Reflector Pattern

Two specialized LLM agents coordinate memory:

- **Observer** — Reads new message history plus existing observations. Extracts discrete facts, decisions, preferences, and working context. Tracks `currentTask` and `suggestedResponse` for session continuity.
- **Reflector** — Takes the full observation log when it grows too large. Compresses it by removing duplication, merging related items, and prioritizing recent/actionable information.

Both agents use configurable models (default: `google/gemini-2.5-flash`) and support per-section custom instructions for domain-specific extraction. Each call goes through pi's `ModelRegistry` for auth resolution, so OAuth refresh and provider failover work the same way they do for the main agent.

## Configuration

Configuration merges from multiple sources (highest precedence first):

1. **Environment variables**
2. **Project config** — `<cwd>/.pi/om-config.json`
3. **Global config** — `~/.pi/om-config.json`
4. **Built-in defaults**

### Example Config

```json
{
  "observation": {
    "messageTokens": 70000,
    "provider": "google",
    "modelId": "gemini-2.5-flash",
    "temperature": 0.2,
    "customInstruction": "Focus on architectural decisions and rejected alternatives."
  },
  "reflection": {
    "observationTokens": 50000,
    "provider": "google",
    "modelId": "gemini-2.5-flash",
    "temperature": 0.2
  },
  "storage": {
    "stateDir": "/custom/state/dir"
  },
  "debug": false
}
```

### Config Reference

| Key | Default | Env Override | Description |
|-----|---------|--------------|-------------|
| `observation.messageTokens` | `70000` | `OM_OBSERVATION_MESSAGE_TOKENS` | Unobserved-token threshold that triggers observation |
| `observation.provider` | `google` | `OM_OBSERVATION_PROVIDER` | pi-ai provider for the observer agent |
| `observation.modelId` | `gemini-2.5-flash` | `OM_OBSERVATION_MODEL` | Model ID for the observer agent |
| `observation.temperature` | unset | `OM_OBSERVATION_TEMPERATURE` | Temperature for observer calls. Leave unset for reasoning models that reject the parameter (GPT-5.x, etc.). |
| `observation.customInstruction` | — | — | Additional instruction injected into observer prompt |
| `reflection.observationTokens` | `50000` | `OM_REFLECTION_OBSERVATION_TOKENS` | Accumulated-observation-token threshold that triggers reflection |
| `reflection.provider` | `google` | `OM_REFLECTION_PROVIDER` | pi-ai provider for the reflector agent |
| `reflection.modelId` | `gemini-2.5-flash` | `OM_REFLECTION_MODEL` | Model ID for the reflector agent |
| `reflection.temperature` | unset | `OM_REFLECTION_TEMPERATURE` | Temperature for reflector calls |
| `reflection.customInstruction` | — | — | Additional instruction injected into reflector prompt |
| `storage.stateDir` | `<cwd>/.pi/om-state` | — | Directory for session state JSON files |
| `debug` | `false` | `OM_DEBUG=1` | Verbose logging to stderr |

### Temperature Note

Reasoning models (GPT-5.x, some Opus 4.6 variants) reject the `temperature` parameter entirely. The default is **unset** so the extension works with any model out of the box. If your observer/reflector model supports temperature and you want deterministic output, set `observation.temperature: 0.2` and/or `reflection.temperature: 0.2` (matching the opencode reference's behavior).

### Debug Mode

Set `OM_DEBUG=1` for verbose logging to stderr covering observation cycles, token counts, state persistence, and hook firing.

## Tools

The extension registers two tools that the LLM can call during sessions:

### `om_status`

Returns current session memory metrics as JSON: observation token counts, thresholds, cursor mode, unobserved message count, cycle history, current task, and suggested response. Accepts an optional `session_id` parameter to query any session (defaults to the current one).

### `om_observations`

Returns the stored observation block for the current session as XML-wrapped text, including `<observations>`, `<current-task>`, and `<suggested-response>` sections.

## Lifecycle Hooks

| Hook | Trigger | Action |
|------|---------|--------|
| `session_start` | Session created (fires on `bindExtensions`) | Initialize/load session state from disk |
| `before_agent_start` | Before each agent loop | Append observation context + continuation reminder to system prompt |
| `context` | Before each LLM call | Prune messages to the unobserved window |
| `agent_end` | After agent loop finishes | Run observation cycle if thresholds met; trigger reflection if needed |
| `session_before_compact` | Before context compaction | Force a final observation pass and inject a custom `CompactionResult` that includes the observation block |
| `session_shutdown` | Process exit | Persist final state |

### Important: Observation Timing Deviation

Unlike the opencode reference, observation cycles run **only in `agent_end`**, not during every LLM call. System prompt injection happens once per agent loop in `before_agent_start`, not per turn. This is an intentional trade-off to avoid drift between the system prompt and the pruning cursor within a long agent loop.

**Full rationale and mitigations**: see [`docs/observation-timing-deviation.md`](docs/observation-timing-deviation.md).

## Testing

The package ships with a layered test harness:

```bash
npm test            # Layers 1-3 (unit + state machine + extension wiring), ~2s, no LLM calls
npm run test:watch  # Dev loop
npm run smoke       # Layer 4: real pi session + real LLM, scripted file-reading workflow
```

### Layer 1-3 (automated)

110+ vitest tests covering:
- Pure functions: prompt parsing, token counting, cursor math, append semantics, config loading, state persistence
- State machine: observation cycle thresholds, reflection cascade, cursor advancement, inflight deduplication
- Extension wiring: all lifecycle hooks + both tools via a fake `ExtensionAPI` dispatcher

### Layer 4: e2e smoke script

`npm run smoke` runs a real pi session with the extension loaded, low OM thresholds, and a scripted two-prompt file-reading workflow. Uses a companion verification extension to capture hook firing order, system prompts, and message pruning. Requires a working pi config (`~/.pi/agent/settings.json`) and auth.

Override the agent model via env vars:

```bash
PI_SMOKE_PROVIDER=openai-codex PI_SMOKE_MODEL=gpt-5.4-mini npm run smoke
```

## Differences from the OpenCode version

| Area | OpenCode | pi port |
|------|----------|---------|
| **LLM client** | Direct OpenAI SDK with `baseURL`/`apiKey` | pi-ai's `completeSimple` via pi's `ModelRegistry` auth chain |
| **Config shape** | `api.baseURL` + `api.apiKey` + `model` string | `provider` + `modelId` (pi-ai registry) |
| **Auth** | `OM_API_KEY` / `OPENAI_API_KEY` env vars | `~/.pi/agent/auth.json` + env vars + OAuth refresh (via `ctx.modelRegistry`) |
| **Config path** | `.opencode/om-config.json`, `~/.config/opencode/om-config.json` | `.pi/om-config.json`, `~/.pi/om-config.json` |
| **Temperature** | Hard-coded `0.2` | Configurable per section, defaults unset (for GPT-5.x reasoning models) |
| **Agent filtering** | `agents` config restricts OM to specific agent names | Removed — pi sessions are single-agent |
| **Observation trigger** | On `session.idle` and before every LLM call (`messages.transform`) | On `agent_end` only |
| **System prompt injection** | Per-call via `system.transform` hook | Once per agent loop via `before_agent_start` |
| **Compaction behavior** | Pushes observations into the default compaction's context | Returns a custom `CompactionResult` with observations baked into the summary, skipping pi's default LLM summarization |
| **Tool output** | `om_observations` writes to a temp file and returns the path | Returns inline content (better for pi's tool model) |

The **core OM engine** — observer/reflector prompts, token thresholds, cursor modes, append semantics, XML output parsing, `currentTask` / `suggestedResponse` tracking — is preserved character-for-character from the opencode reference.

## Why Observational Memory?

Even models with large context windows degrade as the window fills. More raw history means more noise, worse adherence to instructions, and wasted tokens on content the agent no longer needs. Mastra calls these **context rot** and **context waste**, and [their observational memory system](https://mastra.ai/docs/memory/observational-memory) addresses both.

The idea mirrors how human memory works: you don't remember every word of every conversation. You observe what happened, then your brain reflects by reorganizing, combining, and condensing into long-term memory. OM works the same way, compressing raw context into dense observations (typically 5–40x compression) that keep the agent on task over arbitrarily long sessions.

The result is a context window with three tiers:

1. **Recent messages** — exact conversation history since the last observation cycle
2. **Observations** — a dense log of what the observer has extracted, injected into the system prompt
3. **Reflections** — condensed observations when the log itself grows too large

For deeper background, see [Mastra's observational memory docs](https://mastra.ai/docs/memory/observational-memory) and their [announcement post](https://mastra.ai/blog/observational-memory) covering the design rationale and LongMemEval benchmark results.

## Source Layout

```
src/
  index.ts         Extension entry point, event handlers, tool registration
  engine.ts        Core OM engine (cursor, observation cycle, context building)
  agents.ts        Observer/reflector LLM agents + output parsing + auth resolver
  config.ts        Configuration loading and merging
  prompts.ts       Prompt templates for observer/reflector
  state.ts         Session state persistence (JSON files)
  tokens.ts        Token counting (js-tiktoken, o200k_base)
  types.ts         TypeScript interfaces
  __tests__/       Layered test suite (unit, integration, extension)
scripts/
  e2e-smoke.ts     End-to-end smoke test against real pi + real LLM
  e2e-verification.ts  Companion extension for capturing hook state
docs/
  observation-timing-deviation.md  Rationale for the per-loop vs per-call observation model
```

## Dependencies

**Runtime**: `js-tiktoken` (token counting, `o200k_base` encoding)

**Peer**: `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`

**Dev**: `vitest`, `tsx`, `typescript`

## License

MIT (inherits from the sbd-pi-extensions monorepo)
