# Beadwork Troubleshooting — Reference

## Table of Contents

- [Wrong CLI Muscle Memory](#wrong-cli-muscle-memory)
- [Dependency Issues](#dependency-issues)
- [Sync Issues](#sync-issues)
- [Migration](#migration)
- [Common Problems](#common-problems)
- [Health Check](#health-check)

---

## Wrong CLI Muscle Memory

This workflow uses **Beadwork (`bw`)**, not beads_rust (`br`).

### Nonexistent or Wrong Commands

| Do not use | Use instead |
|------------|-------------|
| `br ...` | `bw ...` |
| `bv ...` | `bw ready`, `bw blocked`, `bw list`, `bw show` |
| `bw dep cycles` | No equivalent; cycles are rejected on `bw dep add` |
| `bw dep tree` | `bw show <id> --only blockedby,unblocks` |
| `bw dep list` | `bw show <id>` or `bw list --json` |
| `bw search "text"` | `bw list --grep "text"` |
| `bw sync --flush-only` | `bw sync` or `bw export` |
| `git add .beads/` | Nothing; Beadwork does not use `.beads/` |

---

## Dependency Issues

### Dependency Direction

Beadwork dependency syntax is explicit:

```bash
bw dep add <blocker> blocks <blocked>
bw dep remove <blocker> blocks <blocked>
```

Read it aloud: **the first issue blocks the second issue**.

Example:

```bash
bw dep add bw-auth blocks bw-dashboard
```

Meaning: `bw-auth` must complete before `bw-dashboard` becomes ready.

### Ready Set Conflicts

Treat `bw ready` as the parallel execution frontier. If two ready issues cannot safely be assigned to different agents at the same time, the graph or issue boundaries are wrong.

Fix by either:

```bash
# Add the missing ordering relationship
bw dep add <blocker> blocks <blocked>
```

Or split/reshape the issues so they no longer contend for the same API, schema, migration, fixtures, generated artifacts, files, or acceptance flow. Do not add dependencies only for narrative order; that unnecessarily serializes independent work.

### Cycle Detection

There is no command to list cycles:

```bash
# DOES NOT EXIST
bw dep cycles
```

Beadwork prevents cycles when relationships are added or updated. If a dependency would make a cycle, `bw dep add` fails with a circular dependency error. Parent hierarchy cycles are similarly rejected by `bw update --parent`.

### Inspecting the Graph

```bash
bw ready                                    # Issues not blocked
bw blocked                                  # Issues waiting on blockers
bw show <id> --only blockedby,unblocks      # Dependency context for one issue
bw list --parent <id>                       # Children of a parent/epic
```

---

## Sync Issues

### Sync Commands

| Command | What it does |
|:--------|:-------------|
| `bw sync` | Fetch, rebase/replay, and push Beadwork data |
| `bw export > issues.jsonl` | Export JSONL for inspection or migration |
| `bw import issues.jsonl --dry-run` | Preview an import |
| `bw import issues.jsonl` | Import JSONL |

### No `.beads/` Directory

Beadwork stores data on the `beadwork` git branch through go-git and leaves the working tree untouched. Do not manually commit issue files:

```bash
# WRONG: legacy beads workflow
# git add .beads/
# git commit -m "update beads"

# RIGHT
bw sync
```

### No Sync Worktree Branch Setup

Beadwork does not require configuring `sync.branch`, creating `beads-sync`, or checking out a sync worktree. If older docs mention those steps, ignore them for this workflow.

---

## Migration

### Beads to Beadwork

```bash
bw init
bd export | bw import -
bw sync
```

### Beadwork to Beads

```bash
bw export > issues.jsonl
bd import -i issues.jsonl
```

Use `bw export --status open` to export only open issues. Use `bw import <file> --dry-run` to preview imports.

---

## Common Problems

| Problem | Diagnosis | Fix |
|:--------|:----------|:----|
| `br` not found | Skill/document still assumes beads_rust | Replace with `bw` commands |
| `bw dep cycles` fails | Command does not exist | Rely on `bw dep add` cycle rejection; inspect with `bw ready`/`bw blocked`/`bw show` |
| Wrong dependency direction | Blocked issue appears ready too early | Re-read as `<blocker> blocks <blocked>` and fix with `bw dep remove`/`bw dep add` |
| Ready issues conflict | `bw ready` includes work that would collide in parallel | Add a true blocker dependency or split/reshape the issues; do not rely on agents to discover conflicts later |
| Search command missing | `bw search` fails | Use `bw list --grep "text"` |
| Sync flag missing | `bw sync --flush-only` fails | Use `bw sync`; use `bw export` for JSONL |
| `.beads/` missing | Looking for legacy working-tree files | Correct; Beadwork stores data on the `beadwork` branch |
| Labels command wrong | `bw label add` fails | Use `bw label <id> +label [-label]...` |

---

## Health Check

```bash
which bw              # Verify bw is installed
bw --help             # Confirm current command surface
bw config list        # Show settings
bw list --all         # Show all issues
bw ready              # Actionable work
bw blocked            # Blocked work
```

For one issue:

```bash
bw show <id>
bw show <id> --only blockedby,unblocks
bw history <id> --limit 5
```
