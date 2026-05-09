# Beadwork Issue Anatomy — What Makes a Good Issue

## Table of Contents

- [Example Issue](#example-issue)
- [Required Elements](#required-elements)
- [Description Guidelines](#description-guidelines)
- [Anti-Patterns](#anti-patterns)
- [Creating Issues with bw](#creating-issues-with-bw)
- [Issue Types](#issue-types)
- [Priority Levels](#priority-levels)
- [Concurrency Model](#concurrency-model)
- [Dependency Best Practices](#dependency-best-practices)

---

## Example Issue

A well-formed Beadwork issue looks like:

```
ID: bw-7f3a2c
Title: Implement OAuth2 login flow
Type: feature
Priority: P1
Status: open

Blocked by: [bw-e9b1d4 (User model), bw-c4d5e6 (Session management)]
Unblocks: [bw-a1b2c3 (Protected routes), bw-f7g8h9 (User dashboard)]

Description:
Implement OAuth2 login flow supporting Google and GitHub providers.

## Background
This is the primary authentication mechanism for the application.
Users should be able to sign in with existing Google/GitHub accounts
to reduce friction.

## Technical Approach
- Use NextAuth.js for OAuth2 implementation
- Store provider tokens encrypted in Supabase
- Create unified user record on first login
- Handle account linking for multiple providers

## Success Criteria
- User can click "Sign in with Google/GitHub"
- OAuth flow completes and redirects to dashboard
- User record created/updated in database
- Session cookie set correctly
- Logout clears session properly

## Test Plan
- Unit: Token encryption/decryption
- Unit: User record creation
- E2E: Full OAuth flow (mock provider)
- E2E: Account linking scenario

## Considerations
- Handle provider API rate limits
- Graceful degradation if provider is down
- GDPR compliance for EU users
```

---

## Required Elements

| Element | Purpose | Example |
|---------|---------|---------|
| **ID** | Unique identifier | `bw-7f3a2c` |
| **Title** | Clear, actionable | "Implement OAuth2 login flow" |
| **Type** | Categorization | `feature`, `bug`, `task`, `epic` |
| **Priority** | Importance (P0-P4) | `P1` (high) |
| **Status** | Current state | `open`, `in_progress`, `closed` |
| **Blocked by / unblocks** | Dependency context and concurrency coordination | Created with `bw dep add <blocker> blocks <blocked>` |
| **Parent** | Epic/child grouping | `bw create "Child" --parent <epic-id>` |
| **Description** | Self-contained context | Markdown with sections |

---

## Description Guidelines

### Must Include

| Section | Content |
|---------|---------|
| **Background** | Why this exists, context |
| **Technical Approach** | How to implement |
| **Success Criteria** | How to verify done |
| **Test Plan** | Unit + E2E tests |
| **Considerations** | Edge cases, risks |

### Good Description Properties

1. **Self-contained** — Never need to refer back to original plan
2. **Self-documenting** — Future you can understand it
3. **Verbose** — More detail is better than less
4. **Actionable** — Clear what to do
5. **Parallel-safe** — If the issue is ready, it can be worked alongside every other ready issue without avoidable conflicts

### Description Checklist

- [ ] Background explains WHY
- [ ] Technical approach explains HOW
- [ ] Success criteria define DONE
- [ ] Test plan ensures QUALITY
- [ ] Considerations prevent SURPRISES

---

## Anti-Patterns

### Too Short

```
# BAD
Title: Fix login
Description: Fix the login bug
```

### Too Vague

```
# BAD
Title: Improve authentication
Description: Make auth better
```

### Missing Dependencies

```
# BAD
Title: Implement protected routes
Description: Add route protection
# No mention of auth dependency and no bw dep add link; this would make protected-routes appear ready while auth is still unstable.
```

### Wrong Dependency Direction

```bash
# BAD: old/nonexistent shorthand
bw dep add protected-routes auth

# GOOD: auth blocks protected routes
bw dep add bw-auth blocks bw-protected-routes
```

### Oversimplified

```
# BAD (lost complexity)
Title: Add user management
Description: CRUD for users

# GOOD (preserves complexity)
Title: Add user management with role-based access
Description:
## Background
Users need CRUD operations with granular permissions.
Admin users can manage all users; regular users can only
view/edit their own profile.

## Technical Approach
- Implement RBAC middleware
- Create admin-only routes
- Add ownership validation
- Handle permission errors gracefully
...
```

---

## Creating Issues with bw

### Basic Creation

```bash
bw create "Implement OAuth2 login flow" \
  --type feature \
  --priority 1 \
  --description "$(cat description.md)"
```

### Child Issues / Epics

```bash
EPIC_ID=$(bw create "Authentication epic" --type epic --priority 1 --silent)
bw create "Implement OAuth2 login flow" --parent "$EPIC_ID" --type feature --priority 1
```

### Add Dependencies After

Beadwork dependency direction is explicit English:

```bash
bw dep add bw-e9b1d4 blocks bw-7f3a2c  # User model blocks OAuth
bw dep add bw-c4d5e6 blocks bw-7f3a2c  # Session mgmt blocks OAuth
```

Read it as: **the first issue blocks the second issue**.

There is no `bw dep cycles`; dependency cycles are rejected when `bw dep add` runs.

### Add Labels

```bash
bw label bw-7f3a2c +auth +backend +security
```

### View Complete Issue

```bash
bw show bw-7f3a2c
# or
bw show bw-7f3a2c --json | jq
```

---

## Issue Types

| Type | Use For |
|------|---------|
| `epic` | Large features with many child issues |
| `feature` | New functionality |
| `task` | Non-feature work (config, setup) |
| `bug` | Defect fix |
| `chore` | Maintenance, cleanup |

---

## Priority Levels

| Priority | Meaning | When to Use |
|----------|---------|-------------|
| P0 | Critical | Blocking release, security |
| P1 | High | Core feature, important |
| P2 | Medium | Nice to have this sprint |
| P3 | Low | Future work |
| P4 | Backlog | Maybe someday |

---

## Concurrency Model

A Beadwork graph defines the safe parallel execution frontier.

- `bw ready` means **eligible to start now**, not merely "next in the story." Assume each ready bead may be assigned to a different agent immediately.
- Dependencies are the coordination mechanism. Use `bw dep add <blocker> blocks <blocked>` when the blocked issue depends on an artifact, decision, API/schema, migration, fixture, generated output, or file region owned by the blocker.
- Avoid dependency chains that encode narrative order rather than real coordination needs. They serialize independent work and waste agent parallelism.
- If two ready issues could collide, either reshape/split the work so they are independent or add the dependency that makes the ordering explicit.
- A good graph should pass this test: "Would it be safe to let separate agents start every `bw ready` issue right now?"

---

## Dependency Best Practices

### Do

- Make ALL blocking relationships explicit.
- Use `bw dep add <blocker> blocks <blocked>` and read it aloud.
- Treat `bw ready` as a parallel-safe frontier; ready issues may be worked concurrently.
- Keep dependency chains shallow when possible.
- Use `bw ready`, `bw blocked`, and `bw show <id> --only blockedby,unblocks` to inspect the graph.
- Trust `bw dep add`/`bw update --parent` to reject cycles at mutation time.

### Don't

- Create circular dependencies.
- Use nonexistent commands like `bw dep cycles`, `bw dep tree`, or `bw dep list`.
- Use old `br dep add child parent` syntax.
- Leave implicit dependencies.
- Use dependencies for aesthetic or narrative ordering rather than true coordination needs.
- Leave conflicts in the ready set and rely on agents to discover them later.
- Skip dependencies because "it's obvious".
- Create deep chains that serialize all work.
