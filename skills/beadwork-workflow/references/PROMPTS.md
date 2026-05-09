# Complete Beadwork Prompt Reference

## Table of Contents

- [Plan to Beadwork Conversion](#plan-to-beadwork-conversion)
- [Polishing Prompts](#polishing-prompts)
- [Concurrency Review Reminder](#concurrency-review-reminder)
- [Fresh Session Prompts](#fresh-session-prompts)
- [Test Coverage](#test-coverage)
- [Command Guardrails](#command-guardrails)

---

## Plan to Beadwork Conversion

### THE EXACT PROMPT — Full Version

```
OK so now read ALL of [YOUR_PLAN_FILE].md; please take ALL of that and elaborate on it and use it to create a comprehensive and granular set of Beadwork issues for all this with tasks, subtasks/children, and dependency structure overlaid, with detailed comments so that the whole thing is totally self-contained and self-documenting (including relevant background, reasoning/justification, considerations, etc.-- anything we'd want our "future self" to know about the goals and intentions and thought process and how it serves the over-arching goals of the project.). The issues should be so detailed that we never need to consult back to the original markdown plan document. Design the graph assuming every bead shown by `bw ready` can and will be worked in parallel with every other ready bead; dependencies are how we coordinate concurrency and prevent conflicts, so add dependency links for true ordering/coordination needs and avoid accidental serialization. Remember to ONLY use the `bw` tool to create and modify the issues and add dependencies. Use `bw dep add <blocker> blocks <blocked>` for dependencies. Do not use `br`, `bv`, `.beads/`, or nonexistent commands like `bw dep cycles`. Use ultrathink.
```

**Replace** `[YOUR_PLAN_FILE].md` with your actual plan filename.

### THE EXACT PROMPT — Short Version

```
OK so please take ALL of that and elaborate on it more and then create a comprehensive and granular set of Beadwork issues for all this with tasks, subtasks/children, and dependency structure overlaid, with detailed comments so that the whole thing is totally self-contained and self-documenting (including relevant background, reasoning/justification, considerations, etc.-- anything we'd want our "future self" to know about the goals and intentions and thought process and how it serves the over-arching goals of the project.) Design the graph assuming every bead shown by `bw ready` can and will be worked in parallel with every other ready bead; dependencies are how we coordinate concurrency and prevent conflicts, so add dependency links for true ordering/coordination needs and avoid accidental serialization. Use only the `bw` tool to create and modify issues and add dependencies. Use `bw dep add <blocker> blocks <blocked>` for dependencies. Do not use `br`, `bv`, `.beads/`, or nonexistent commands like `bw dep cycles`. Use ultrathink.
```

**Use when:** Plan is already in context from earlier conversation.

---

## Polishing Prompts

### THE EXACT PROMPT — Polish (Standard)

```
Reread AGENTS dot md so it's still fresh in your mind. Check over each Beadwork issue super carefully-- are you sure it makes sense? Is it optimal? Could we change anything to make the system work better for users? If so, revise the issues. It's a lot easier and faster to operate in "plan space" before we start implementing these things!

DO NOT OVERSIMPLIFY THINGS! DO NOT LOSE ANY FEATURES OR FUNCTIONALITY!

Also, make sure that as part of these issues, we include comprehensive unit tests and e2e test scripts with great, detailed logging so we can be sure that everything is working perfectly after implementation. Review the dependency graph as a concurrency contract: every `bw ready` bead can and will be worked in parallel with the others, so add missing blockers for conflicts and remove unnecessary blockers that only serialize independent work. Remember to ONLY use the `bw` tool to create and modify issues and to add dependencies. Use `bw dep add <blocker> blocks <blocked>` for dependencies. Do not use `br`, `bv`, `.beads/`, or nonexistent commands like `bw dep cycles`. Use ultrathink.
```

### THE EXACT PROMPT — Polish (Full with Plan Reference)

```
Reread AGENTS dot md so it's still fresh in your mind. Then read ALL of [YOUR_PLAN_FILE].md. Use ultrathink. Check over each Beadwork issue super carefully-- are you sure it makes sense? Is it optimal? Could we change anything to make the system work better for users? If so, revise the issues. It's a lot easier and faster to operate in "plan space" before we start implementing these things! DO NOT OVERSIMPLIFY THINGS! DO NOT LOSE ANY FEATURES OR FUNCTIONALITY! Also make sure that as part of the issues we include comprehensive unit tests and e2e test scripts with great, detailed logging so we can be sure that everything is working perfectly after implementation. It's critical that EVERYTHING from the markdown plan be embedded into the issues so that we never need to refer back to the markdown plan and we don't lose any important context or ideas or insights into the new features planned and why we are making them. Review the dependency graph as a concurrency contract: every `bw ready` bead can and will be worked in parallel with the others, so add missing blockers for conflicts and remove unnecessary blockers that only serialize independent work. Use `bw dep add <blocker> blocks <blocked>` for dependencies. Use only `bw`; do not use `br`, `bv`, `.beads/`, or nonexistent commands like `bw dep cycles`.
```

**Use when:** You want to ensure nothing from the original plan was lost.

### Polishing Protocol

```
Round 1 → Significant changes expected
Round 2 → Moderate changes
Round 3 → Fewer changes
...
Round 6-9 → Steady-state (minimal changes)

If flatlines early → Start fresh agent session
Cross-model review → Have another strong model do final round
```

### Concurrency Review Reminder

Use this inside creation or polish prompts when dependency design matters:

```
Treat `bw ready` as the executable frontier: every ready bead may be picked up by a different agent at the same time. Dependencies are the coordination contract that makes this safe. Add blockers for true ordering, semantic, API/schema, migration, test, fixture, generated-artifact, or file-level conflicts. Do not add dependencies merely for narrative order or tidy sequencing, because that collapses useful parallelism.
```

---

## Fresh Session Prompts

When polishing flatlines, start a brand new coding-agent session:

### THE EXACT PROMPT — Step 1: Re-establish Context

```
First read ALL of the AGENTS dot md file and README dot md file super carefully and understand ALL of both! Then use your code investigation agent mode to fully understand the code, and technical architecture and purpose of the project. Use ultrathink.
```

### THE EXACT PROMPT — Step 2: Review Beadwork Issues

```
We recently transformed a markdown plan file into a bunch of new Beadwork issues. I want you to very carefully review and analyze these using `bw` only. Treat the dependency graph as a concurrency contract: every issue returned by `bw ready` can and will be worked in parallel with the others, so identify missing blockers for conflicts and unnecessary blockers that serialize independent work. Do not use `br`, `bv`, `.beads/`, or nonexistent commands like `bw dep cycles`.
```

### THE EXACT PROMPT — Step 3: Polish

Then follow with the standard polish prompt.

---

## Test Coverage

### THE EXACT PROMPT — Add Test Issues

```
Do we have full unit test coverage without using mocks/fake stuff? What about complete e2e integration test scripts with great, detailed logging? If not, then create a comprehensive and granular set of Beadwork issues for all this with tasks, subtasks/children, and dependency structure overlaid with detailed comments. Make the test-work graph parallel-safe: every `bw ready` test issue may be assigned concurrently, with dependencies only where setup, fixtures, generated artifacts, or implementation work must complete first. Use only `bw`. Do not use `br`, `bv`, `.beads/`, or nonexistent commands like `bw dep cycles`.
```

**Use when:** Feature issues exist but test coverage is unclear.

---

## Command Guardrails

Use these reminders inside prompts when an agent may have stale Beads muscle memory:

```
Important Beadwork command guardrails:
- Use `bw`, not `br`.
- Use `bw dep add <blocker> blocks <blocked>`.
- Treat `bw ready` as the parallel execution frontier; every ready issue may be worked concurrently.
- There is no `bw dep cycles`; cycles are rejected when dependencies are added.
- There is no `.beads/` directory to commit; use `bw sync`.
- There is no `bw search`; use `bw list --grep "text"`.
- Do not use `bv`; inspect work with `bw ready`, `bw blocked`, `bw list`, and `bw show`.
```

---

## Cross-Model Review Pattern

| Model | Role | Prompt |
|-------|------|--------|
| Claude/Opus | Primary creation | Plan to Beadwork (Full) |
| Claude/Opus | Multiple polish rounds | Polish (Standard) |
| Codex/GPT | Final review | Polish (Standard) |
| Gemini | Alternative perspective | Fresh Session → Review |

---

## Prompt Usage Summary

| Stage | Prompt | Repetitions |
|-------|--------|-------------|
| Initial conversion | Plan to Beadwork | 1x |
| Polishing | Polish (Standard) | 6-9x |
| Flatline recovery | Fresh Session | As needed |
| Test coverage | Add Test Issues | 1x |
| Final review | Polish (cross-model) | 1-2x |
