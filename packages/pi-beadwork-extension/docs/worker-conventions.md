# Worker conventions

These conventions are baked into the current-branch worker handoff and are also safe habits for
worktree workers. They exist because multiple agents may share one checkout and because the
orchestrator uses commits and beadwork history as attribution evidence.

## Start and scope

Begin by starting the assigned ticket unless it is already started:

```sh
bw start sbdpi-qmd.5.4
```

Stay scoped to that ticket. If the ticket is too large, unclear, or blocked, coordinate through
beadwork instead of quietly expanding scope:

```sh
bw comment sbdpi-qmd.5.4 "Blocked: command docs mention a config field whose runtime behavior is unclear. Need coordinator decision before documenting timeout semantics."
```

Use dependencies, labels, or child tickets for ordering and follow-up work.

## Commit messages

Every worker commit should include the ticket id.

Good examples:

```text
docs(pi-beadwork): document worker conventions sbdpi-qmd.5.4
fix(pi-beadwork): reject detached head current-branch launch sbdpi-qmd.1.3
test(pi-beadwork): cover current-branch review toggle sbdpi-qmd.2.1
```

Less useful:

```text
update docs
fix stuff
worker changes
```

Ticket ids make later attribution possible even when several workers commit near each other.

## Atomic commits with explicit paths

Prefer committing exact paths:

```sh
git status --short
git diff -- packages/pi-beadwork-extension/docs/worker-conventions.md
git commit packages/pi-beadwork-extension/docs/worker-conventions.md \
  -m "docs(pi-beadwork): document worker conventions sbdpi-qmd.5.4"
```

Avoid broad staging in shared checkouts:

```sh
# Avoid unless you have inspected every path and all of it is ticket-scoped.
git add -A
git add .
git commit -a -m "..."
```

Why: the git index is shared with the checkout. Another worker, a human, or a tool may have dirty
files present. `git commit <specific-files> -m ...` avoids accidentally staging unrelated work.

## Handoff comments

Before exiting, leave a natural-language handoff comment:

```sh
bw comment sbdpi-qmd.5.4 "Docs complete. Commits: abc1234, def5678. Validation: npm run lint -w @solvedbydev/pi-beadwork-extension passed. No blockers. Follow-up: none."
```

Include what matters:

- status;
- commit SHAs when known;
- validation commands and whether they passed, failed, or were skipped;
- blockers;
- follow-up recommendations.

Do not force a rigid schema. Beadwork comments are durable context for people, LLMs, reviewers, and
future workers. They are not parsed as a strict protocol by the implementation.

## Close and sync

When done:

```sh
bw close sbdpi-qmd.5.4
bw sync
```

If blocked, leave the ticket open with a clear `bw comment` and exit. Do not close a ticket just to
make a worker look complete.

## Fix forward

Current-branch attribution is evidence-based, not magic. If a worker forgot a perfect handoff, used
a weak commit message, or produced ambiguous attribution, prefer adding durable clarification:

```sh
bw comment sbdpi-qmd.5.4 "Attribution note: commit abc1234 is the docs-only implementation for this ticket; unrelated dirty files in packages/foo were pre-existing."
```

Create follow-up tickets for remaining work. Avoid rewriting shared history, resetting, or rebasing
other workers' commits unless a human explicitly asks for it.

## Shared checkout etiquette

Do:

- check `git status --short` before committing;
- inspect diffs for the exact files you will commit;
- keep scratch notes under the runtime scratch dir or `/tmp`;
- comment when you discover blockers or scope changes.

Do not:

- stash, reset, clean, or checkout away unrelated changes;
- assume untracked files belong to you;
- create branches, PRs, or worktrees from current-branch mode unless instructed;
- hide validation failures in a vague handoff.

## Worktree workers

Worktree mode still benefits from the same commit and handoff conventions, but it has stronger file
isolation. Worktree workers run in a per-ticket worktree and the orchestrator owns validation,
review, merge-back, and cleanup according to `landing.*` and `worktrees.*` config.
