# AGENTS.md — @solvedbydev/pi-hashline-readmap

This package is maintained inside the `@solvedbydev/pi-extensions` npm workspace monorepo. The repository-level `AGENTS.md` at the workspace root is authoritative for workflow, commits, and quality gates.

## What This Package Is

`@solvedbydev/pi-hashline-readmap` is a unified pi extension that replaces and augments several local coding tools:

- `read` — hashlined reads, structural maps, symbol-addressable reads
- `edit` — hash-anchored edits with semantic diff summaries
- `grep` — hashlined search results
- `ast_search` — ast-grep wrapper with hashlined output
- `write` — file creation/full overwrite with returned anchors
- `ls` / `find` — agent-friendly file exploration
- `bash` post-processing — command-aware output compression

The standalone upstream Nushell integration is intentionally not included in this port.

## Development

From the workspace root, prefer the scoped scripts while iterating:

```bash
npm run lint -w @solvedbydev/pi-hashline-readmap
npm run test -w @solvedbydev/pi-hashline-readmap
npm run typecheck -w @solvedbydev/pi-hashline-readmap
npm run build -w @solvedbydev/pi-hashline-readmap
```

Before completing work, run the repository-level quality gates required by the root `AGENTS.md` when practical:

```bash
npm run lint
npm run test
npm run typecheck
```

## Source Map

- `src/index.ts` — monorepo extension entry point
- `index.ts` — package-root compatibility re-export
- `src/read.ts`, `src/edit.ts`, `src/grep.ts`, `src/sg.ts`, `src/write.ts`, `src/ls.ts`, `src/find.ts` — tool implementations
- `src/readmap/` — structural mapping and symbol lookup
- `src/rtk/` — bash output routing and compression
- `prompts/` — tool prompt/schema docs
- `scripts/` — helper scripts used by readmap internals
- `tests/` — feature-focused tests and fixtures

## Package Notes

- Keep pi runtime packages external in `tsdown.config.ts`; pi resolves them at runtime.
- Runtime CLI dependencies such as `@ast-grep/cli` belong in `dependencies`.
- `dist/`, `.pi/`, `tmp/`, and generated helper binaries are local artifacts and should not be committed.
