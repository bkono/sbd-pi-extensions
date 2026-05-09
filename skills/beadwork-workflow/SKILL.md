---
name: beadwork-workflow
description: >-
  Convert markdown plans into Beadwork issues with dependencies using the bw CLI.
  Use when creating task graphs, polishing issues before implementation, or
  bridging planning to agent swarm execution.
---

<!-- TOC: Quick Start | Exact Prompts | Dependency Design | Polishing | Fresh Sessions | bw Commands | Migration | Quality Checklist | Agent Mail | Ready Criteria | Troubleshooting | References -->

# Beadwork Workflow — From Plan to Actionable Tasks

> **Core Principle:** "Check your beads N times, implement once" — where N is as many as you can stomach.
>
> Beadwork issues should be detailed enough that a swarm of agents can implement them mechanically without reopening the original markdown plan.
>
> **Concurrency Principle:** A bead returned by `bw ready` is eligible to be worked immediately, in parallel with every other ready bead. Dependencies are the coordination mechanism: add them when work must be ordered to avoid semantic, API, migration, test, or file-level conflicts; do not add them just to make the graph look tidy.

## Critical Beadwork Differences

This skill is for **Beadwork (`bw`)**, not beads_rust (`br`).

- Use `bw`, never `br`.
- Dependency syntax is `bw dep add <blocker> blocks <blocked>`.
- There is no `bw dep cycles`, `bw dep tree`, or `bw dep list` command.
- Dependency and parent cycles are rejected when you add/update relationships.
- There is no `.beads/` working-tree directory to commit.
- `bw sync` fetches/rebases/pushes the Beadwork branch; do not run `git add .beads/`.
- Use `bw list --grep`, not `bw search`.
- Do not use `bv`; this workflow should rely on `bw ready`, `bw blocked`, `bw show`, and `bw list`.

---

## Quick Start

```bash
# 1. Initialize Beadwork in a git repo
bw init

# 2. Convert plan to Beadwork issues (see THE EXACT PROMPT below)

# 3. Polish iteratively
# Run polish prompt 6-9 times until steady-state

# 4. Validate using bw commands
bw ready
bw blocked
bw list --all --json

# 5. Begin implementation
bw ready
bw start <id>
```

---

## THE EXACT PROMPT — Plan to Beadwork Conversion

```
OK so now read ALL of [YOUR_PLAN_FILE].md; please take ALL of that and elaborate on it and use it to create a comprehensive and granular set of Beadwork issues for all this with tasks, subtasks/children, and dependency structure overlaid, with detailed comments so that the whole thing is totally self-contained and self-documenting (including relevant background, reasoning/justification, considerations, etc.-- anything we'd want our "future self" to know about the goals and intentions and thought process and how it serves the over-arching goals of the project.). The issues should be so detailed that we never need to consult back to the original markdown plan document. Design the graph assuming every bead shown by `bw ready` can and will be worked in parallel with every other ready bead; dependencies are how we coordinate concurrency and prevent conflicts, so add dependency links for true ordering/coordination needs and avoid accidental serialization. Remember to ONLY use the `bw` tool to create and modify the issues and add dependencies. Use `bw dep add <blocker> blocks <blocked>` for dependencies. Do not use `br`, `bv`, `.beads/`, or nonexistent commands like `bw dep cycles`. Use ultrathink.
```

### Shorter Version

```
OK so please take ALL of that and elaborate on it more and then create a comprehensive and granular set of Beadwork issues for all this with tasks, subtasks/children, and dependency structure overlaid, with detailed comments so that the whole thing is totally self-contained and self-documenting (including relevant background, reasoning/justification, considerations, etc.-- anything we'd want our "future self" to know about the goals and intentions and thought process and how it serves the over-arching goals of the project.) Design the graph assuming every bead shown by `bw ready` can and will be worked in parallel with every other ready bead; dependencies are how we coordinate concurrency and prevent conflicts, so add dependency links for true ordering/coordination needs and avoid accidental serialization. Use only the `bw` tool to create and modify issues and add dependencies. Use `bw dep add <blocker> blocks <blocked>` for dependencies. Do not use `br`, `bv`, `.beads/`, or nonexistent commands like `bw dep cycles`. Use ultrathink.
```

### What This Creates

- Issues and child issues with clear scope
- Dependency links (`blocker blocks blocked`)
- Detailed descriptions with background, reasoning, considerations
- Self-contained work items that do not require the original plan

---

## Dependency Design for Parallel Work

Beadwork is a concurrency planner, not just a task list.

- Treat `bw ready` as the executable frontier: every ready bead may be picked up by a different agent at the same time.
- Dependencies are the contract that makes that safe. Add `A blocks B` when B would conflict, duplicate work, depend on unstable API/schema/UX decisions, or require artifacts produced by A.
- Do not use dependencies for aesthetic sequencing, narrative order, or vague "should probably happen first" preferences. That collapses useful parallelism.
- If two beads touch the same files, APIs, migrations, fixtures, generated artifacts, or acceptance flows, either split/reshape them so they can run independently or add the dependency that prevents collision.
- During polishing, inspect the ready set and ask: "Would I be comfortable assigning all of these to separate agents right now?" If not, add missing dependencies or change issue boundaries.

---

## Polishing Beadwork Issues

### THE EXACT PROMPT — Polish (Standard)

```
Reread AGENTS dot md so it's still fresh in your mind. Check over each Beadwork issue super carefully-- are you sure it makes sense? Is it optimal? Could we change anything to make the system work better for users? If so, revise the issues. It's a lot easier and faster to operate in "plan space" before we start implementing these things!

DO NOT OVERSIMPLIFY THINGS! DO NOT LOSE ANY FEATURES OR FUNCTIONALITY!

Also, make sure that as part of these issues, we include comprehensive unit tests and e2e test scripts with great, detailed logging so we can be sure that everything is working perfectly after implementation. Review the dependency graph as a concurrency contract: every `bw ready` bead can and will be worked in parallel with the others, so add missing blockers for conflicts and remove unnecessary blockers that only serialize independent work. Remember to ONLY use the `bw` tool to create and modify issues and to add dependencies. Use `bw dep add <blocker> blocks <blocked>` for dependencies. Do not use `br`, `bv`, `.beads/`, or nonexistent commands like `bw dep cycles`. Use ultrathink.
```

### Polishing Protocol

1. Run polish prompt.
2. Review changes with `bw list --all` and targeted `bw show <id>`.
3. Repeat until steady-state (typically 6-9 rounds).
4. If it flatlines, start a fresh coding-agent session.
5. Optionally have another model do a final round.

---

## Fresh Session Technique

If polishing flatlines, start a new agent session:

### THE EXACT PROMPT — Re-establish Context

```
First read ALL of the AGENTS dot md file and README dot md file super carefully and understand ALL of both! Then use your code investigation agent mode to fully understand the code, and technical architecture and purpose of the project. Use ultrathink.
```

### THE EXACT PROMPT — Then Review Beadwork Issues

```
We recently transformed a markdown plan file into a bunch of new Beadwork issues. I want you to very carefully review and analyze these using `bw` only. Treat the dependency graph as a concurrency contract: every issue returned by `bw ready` can and will be worked in parallel with the others, so identify missing blockers for conflicts and unnecessary blockers that serialize independent work. Do not use `br`, `bv`, `.beads/`, or nonexistent commands like `bw dep cycles`.
```

Then follow up with the standard polish prompt.

---

## bw Commands

### Issue Lifecycle

```bash
bw init                                      # Initialize Beadwork
bw create "Title" --type task --priority 1  # Create issue
bw create "Child" --parent <epic-id>        # Create child issue
bw update <id> --status in_progress
bw start <id>                               # Claim/start work
bw close <id> --reason "Done"
bw reopen <id>                              # If needed
```

### Dependencies

```bash
bw dep add <blocker> blocks <blocked>       # blocker must finish before blocked
bw dep remove <blocker> blocks <blocked>
```

If a child issue depends on a setup issue or concrete artifact-producing parent, add an explicit dependency. Parent/child hierarchy alone is not a dependency and should not serialize sibling work.

```bash
bw dep add <setup-or-artifact-id> blocks <child-id>
```

There is no `bw dep cycles`. Beadwork rejects circular dependency links when `bw dep add` runs.

### Querying

```bash
bw list                                     # Open/in-progress issues, default limit
bw list --all                               # All issues
bw list --grep "authentication"             # Search title/description
bw list --parent <id>                       # Children of an epic/parent
bw ready                                    # Actionable issues (not blocked)
bw blocked                                  # Issues waiting on blockers
bw show <id>                                # Full issue with dependency context
bw show <id> --json                         # Machine-readable single issue
bw list --all --json                        # Machine-readable list
```

### Labels and Comments

```bash
bw label <id> +auth +backend -old-label
bw comment <id> "Important implementation note"
```

### Sync and Data

```bash
bw sync                                     # Fetch, rebase/replay, push Beadwork data
bw export > issues.jsonl                    # JSONL export for inspection/migration
bw import issues.jsonl --dry-run            # Preview JSONL import
bw import issues.jsonl                      # Import JSONL
```

Do not commit `.beads/`; Beadwork stores data on the `beadwork` git branch and leaves the working tree untouched.

---

## Migrating Between Beads and Beadwork

Use this when moving data between legacy beads tooling and Beadwork. Do not rewrite docs to `br`; this workflow uses `bw`.

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

Issue IDs and dependencies are preserved by the JSONL interchange when possible.

---

## Quality Checklist

Before implementation, verify each issue:

- [ ] **Self-contained** — Understandable without external context
- [ ] **Clear scope** — One coherent piece of work
- [ ] **Dependencies explicit** — Blockers linked with `bw dep add <blocker> blocks <blocked>` whenever ordering/coordination is required
- [ ] **Ready means parallel-safe** — Any combination of `bw ready` issues can be worked concurrently without avoidable conflicts
- [ ] **Testable** — Clear success criteria
- [ ] **Includes tests** — Unit and e2e tests in scope
- [ ] **Preserves features** — Nothing from plan was lost
- [ ] **Not oversimplified** — Complexity preserved where needed
- [ ] **Graph makes sense** — `bw ready`, `bw blocked`, and `bw show <id>` tell a coherent concurrency story

---

## Integration with Agent Mail

Use the Beadwork issue ID as the coordination thread:

```python
# Reserve files for issue
file_reservation_paths(..., reason="bw-123")

# Announce work in thread
send_message(..., thread_id="bw-123", subject="[bw-123] Starting...")

# Close issue when done
bw close bw-123 --reason "Completed"
release_file_reservations(...)
```

---

## When Issues Are Ready

Your Beadwork issues are ready for implementation when:

1. **Steady-state reached** — Multiple polish rounds yield minimal changes.
2. **Cross-model reviewed** — At least one alternative model reviewed.
3. **No missing blockers** — `bw ready`, `bw blocked`, and targeted `bw show <id>` output make sense, and the ready set is safe to parallelize.
4. **Tests included** — Each feature has associated test work.
5. **Dependencies clean** — The graph is logical; Beadwork rejected any cycle attempts during creation.

---

## References

| Topic | Reference |
|-------|-----------|
| All prompts | [PROMPTS.md](references/PROMPTS.md) |
| Issue structure | [BEAD-ANATOMY.md](references/BEAD-ANATOMY.md) |
| Troubleshooting | [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md) |
| bw command reference | Run `bw --help` or see the Beadwork README |
| Migration | See Beadwork `docs/migration.md` |

---

## Troubleshooting

### Quick Health Check

```bash
which bw              # Verify bw is installed
bw --help             # Confirm available commands
bw config list        # All settings
bw list --all         # Inspect issues
bw ready              # Inspect actionable issues
bw blocked            # Inspect blocked issues
```

### Common Mistakes

- `bw dep cycles` does not exist; cycles are rejected when dependencies are added.
- `bw dep add child parent` is backwards/wrong syntax; use `bw dep add <blocker> blocks <blocked>`.
- `bw search` does not exist; use `bw list --grep "text"`.
- `bw sync --flush-only` does not exist; use `bw sync` or `bw export`.
- Do not run `git add .beads/`; there is no `.beads/` working-tree directory.

See [TROUBLESHOOTING.md](references/TROUBLESHOOTING.md) for full diagnostics.

---

## Validation

```bash
# Check graph/work queue health
bw ready
bw blocked

# Inspect dependency context for important issues
bw show <id> --only blockedby,unblocks

# Verify all issues have descriptions (JSONL export)
bw export | jq -c 'select((.description // "") == "")'
```
