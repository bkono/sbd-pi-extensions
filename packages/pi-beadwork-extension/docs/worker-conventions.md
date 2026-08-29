# Shared-checkout conventions

In-process minions share the parent checkout by default. Overlap notices are **advisory**: they
warn and suggest communication; they do not lock, pause, or isolate. Treat the index like two
humans on one branch.

tmux worktree workers are gone. See [migration.md](./migration.md).

## Start and scope

The **parent** starts the ticket before the child begins:

```sh
bw start sbdpi-vur.4.4
```

Children get inspection tools only. They must not close tickets. The parent closes after it
judges evidence.

If the ticket is too large, unclear, or blocked, comment (parent) or send a parent-directed
message (live child) instead of quietly expanding scope.

## Commit messages

Include the ticket id.

```text
docs(pi-beadwork): publish cutover README sbdpi-vur.4.4
```

## Atomic commits with explicit paths

```sh
git status --short
git diff -- packages/pi-beadwork-extension/README.md
git commit packages/pi-beadwork-extension/README.md \
  -m "docs: publish minions orchestration cutover README sbdpi-vur.4.4"
```

Avoid `git add -A`, `git add .`, and `git commit -a` unless every path is ticket-scoped. Another
child, a human, or a tool may have dirty files in the same checkout.

## Quality commands

Run the repo’s `lint` / `test` / `typecheck` (or equivalent) in the implementer task, and again
in review or a repo checkpoint when useful. Beadwork does not run `landing.validateCommands`.

## Handoff

Leave a natural-language `bw comment` (parent, after judging) with status, commit SHAs when
known, quality-command results, blockers, and follow-up. Not a rigid schema.

Do not close a ticket solely because a child settled.

## Fix forward

Prefer a clarifying `bw comment` or a follow-up ticket over rewriting shared history. Never
stash, reset, clean, or discard unrelated checkout state — it may belong to another live child.

## Do

- check `git status --short` before committing
- inspect diffs for the exact files you will commit
- treat overlap notices as hints, not locks

## Do not

- stash, reset, clean, or checkout away unrelated changes
- assume untracked files belong to you
- create worktrees unless the operator already supplied an existing `cwd` at group create
- hide quality-command failures in a vague handoff
