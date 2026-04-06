# CLAUDE.md — @solvedbydev/pi-extensions

## Work Management

Committing and closing issues are part of completing a task — not separate
actions requiring additional permission.

We often have multiple agents working at the same time. Because of this, it is
imperative you create atomic commits by staging only your changed files:

```sh
git add <your changed files> && git commit -m "<conventional commit style message>"
```

Use conventional commit prefixes: `feat:`, `fix:`, `chore:`, `refactor:`,
`docs:`, `test:`, `ci:`, etc. Scope to the package when it helps clarity
(e.g., `feat(pi-hello-world): add greet command`).

## Project Structure

npm workspace monorepo using tsdown for builds.

- `packages/*` — libraries (published as `@solvedbydev/*`)
- `apps/*` — applications (bundled to single-binary distributions)

## Quality Gates

No task is considered done until **lint, tests, and typecheck all pass clean**.
Run these before marking work complete, before committing, and before any handoff:

```sh
npm run lint          # biome check (lint + format + organize-imports)
npm run test          # vitest across all workspaces
npm run typecheck     # tsc --noEmit across all workspaces
```

If lint reports fixable issues, apply them with:

```sh
npm run lint:fix      # biome check --write (safe fixes only)
```

Unsafe fixes (`biome check --write --unsafe`) should be reviewed before
committing — they can change behavior in edge cases.

Each workspace package also exposes its own scoped scripts, useful when
iterating within a single package:

```sh
npm run lint -w @solvedbydev/pi-hello-world-extension
npm run lint:fix -w @solvedbydev/pi-hello-world-extension
npm run test -w @solvedbydev/pi-hello-world-extension
npm run typecheck -w @solvedbydev/pi-hello-world-extension
```

Residual warnings are acceptable only when explicitly documented with a
`biome-ignore` comment and justification. Errors are never acceptable in
completed work.

## Build

```sh
npm run build             # tsdown workspace build (all packages + apps)
npm run build:packages    # only packages/*
npm run build:apps        # only apps/*
npm run dev               # tsdown watch mode
```

## Conventions

- **Formatting:** tabs, double quotes, 100 char line width (biome)
- **Commits:** conventional commits (`feat:`, `fix:`, `chore:`, etc.)
- **Namespacing:** all packages use `@solvedbydev/*`
- **Pi extensions:** dev-depend on `@mariozechner/pi-coding-agent`; externalize
  all pi runtime deps in tsdown config (`neverBundle`) since pi loads extensions
  via jiti at runtime
