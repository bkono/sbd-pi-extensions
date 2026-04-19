# @solvedbydev/pi-exa-extension

A [pi coding-agent](https://github.com/badlogic/pi-mono) extension that adds an Exa-backed `web_search` tool with simple configuration via environment variables or JSON config files.

This package is intentionally small and focused:

- one tool: `web_search`
- one config file: `.pi/exa-config.json`
- one primary env var: `PI_EXA_API_KEY`
- Exa-specific internals, but a generic web-search tool surface for the model

It mirrors the Exa-backed web search concept already used in the Alfred assistant runtime, but packages it as a reusable pi extension with the same workspace-style config conventions used elsewhere in this repo.

## Install

### Workspace dependency

```json
{
  "dependencies": {
    "@solvedbydev/pi-exa-extension": "*"
  }
}
```

### Register with pi

Add the extension entrypoint to `settings.json`:

```json
{
  "extensions": [
    "/path/to/sbd-pi-extensions/packages/pi-exa-extension/src/index.ts"
  ]
}
```

## Configuration

Configuration merges in this order:

1. environment variables
2. `<cwd>/.pi/exa-config.json`
3. `~/.pi/exa-config.json`
4. built-in defaults

### Example config

```json
{
  "apiKey": "exa-...",
  "defaultSearchType": "auto",
  "defaultNumResults": 5,
  "maxTextPerResult": 800
}
```

Compatibility aliases are also accepted:

- `exaApiKey` → `apiKey`
- `searchType` → `defaultSearchType`
- `numResults` → `defaultNumResults`
- `EXA_API_KEY` → fallback env alias for `PI_EXA_API_KEY`

### Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PI_EXA_API_KEY` | no | unset | Exa API key. If unset, `web_search` stays registered but throws a clear setup message on first use. |
| `EXA_API_KEY` | no | unset | Compatibility alias used when `PI_EXA_API_KEY` is absent. |
| `PI_EXA_DEFAULT_SEARCH_TYPE` | no | `auto` | Default search mode: `auto`, `neural`, or `keyword`. |
| `PI_EXA_DEFAULT_NUM_RESULTS` | no | `5` | Default result count when the tool call omits `num_results`. Clamped to 1-10. |
| `PI_EXA_MAX_TEXT_PER_RESULT` | no | `800` | Maximum excerpt size from each result included in tool output. |

## Tool surface

### `web_search`

Search the public web via Exa and return ranked results with:

- title
- URL
- optional publication metadata
- trimmed text excerpts

Input shape:

```json
{
  "label": "Find recent docs for Exa search options",
  "query": "Exa search API keyword neural auto",
  "num_results": 5,
  "type": "auto"
}
```

Notes:

- `type: "keyword"` is best for exact terms, identifiers, package names, or quoted text.
- `type: "neural"` is best for broader semantic lookups and exploratory research.
- `type: "auto"` lets Exa choose.
- if `num_results` is omitted, the package uses `defaultNumResults` from config.
- if `type` is omitted, the package uses `defaultSearchType` from config.

## Behavior when not configured

If no API key is configured, the tool remains registered so the extension surface is stable, but the first execution fails with an actionable message telling the user to set:

- `PI_EXA_API_KEY`, or
- `EXA_API_KEY`, or
- `apiKey` in `~/.pi/exa-config.json` or `<cwd>/.pi/exa-config.json`

## Development

Scoped quality checks:

```sh
npm run lint -w @solvedbydev/pi-exa-extension
npm run test -w @solvedbydev/pi-exa-extension
npm run typecheck -w @solvedbydev/pi-exa-extension
```
