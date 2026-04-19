# Beadwork Dashboard TUI Redesign

## Status: In Progress

Comprehensive plan for polishing the Beadwork dashboard TUI to match the visual
quality of the `pi-subagents` chain clarification modal.

---

## Current State Assessment

### What's Wrong

1. **Flat visual hierarchy** — most body text is monochrome; labels, values,
   statuses, and counts all render at the same visual weight.
2. **No semantic color-coding** — issue states, worker states, priorities, and
   types are plain text instead of using theme-driven accent/success/warning/error
   colors.
3. **Compressed status bar** — the header crams repo, activation, mode, scope,
   and counts into dense `key=value` debug-style strings.
4. **Inconsistent spacing** — margins, indentation, and section gaps vary across
   tabs with no coherent rhythm.
5. **Plain borders** — current `renderSurface` uses straight box-drawing chars
   (`┌┐└┘`) instead of the rounded style (`╭╮╰╯`) used by polished pi modals.
6. **Title/footer outside borders** — the title sits above the border rather
   than being embedded in the top border line, and footer hints float below
   rather than being embedded in the bottom border.
7. **No visual weighting** — bold/dim/italic are underused; everything is
   regular weight, making it hard to scan.

### What the Reference Modal Does Well (pi-subagents chain clarify)

1. **Rounded box-drawing borders** (`╭─╮`, `╰─╯`) with title text embedded
   directly into the top border line and footer/hints embedded in the bottom
   border line.
2. **Strong indentation hierarchy** — section headings are left-aligned, content
   is indented 2 spaces, nested content indented 4 spaces.
3. **Semantic color mapping** — selected items get accent color, labels are
   muted, values are normal or bright, status badges use success/warning/error.
4. **Explicit selection markers** — `▸` or `●` for selected items, `○` for
   unselected, making focus immediately obvious.
5. **Mode-specific footer hints** — actions available in the current context are
   listed explicitly with key labels.
6. **Consistent card sizing** — fixed width (84) with `maxHeight` percentage,
   creating a cohesive modal feel.
7. **Transient status feedback** — save/action messages appear briefly (2s
   timeout) and auto-dismiss.

---

## Implementation Plan

### Phase 1: Modernize `tui/common.ts` — Border & Theme Helpers

**Goal:** Upgrade `renderSurface` and add reusable theme-aware helpers.

#### 1a. Rounded borders with embedded title/footer

```
╭─ Beadwork Dashboard ─────────────────────────────╮
│                                                    │
│  content here                                      │
│                                                    │
╰─ tab · tab · tab ── ↑↓ navigate · enter select ──╯
```

- Top border: `╭─ {title} ─…─╮`
- Bottom border: `╰─ {footer} ─…─╯`
- Side borders: `│`
- Separator row: `├─…─┤` (unchanged)

#### 1b. Theme-aware content helpers

New exported helpers in `common.ts`:

| Helper | Purpose |
|--------|---------|
| `styledLabel(theme, text)` | Muted/dim label text |
| `styledValue(theme, text)` | Normal/bright value text |
| `styledAccent(theme, text)` | Accent-colored text (selected, active) |
| `styledSuccess(theme, text)` | Green — completed, landed, passed |
| `styledWarning(theme, text)` | Yellow — held, attention, deferred |
| `styledError(theme, text)` | Red — failed, error, blocked |
| `styledMuted(theme, text)` | Dim — disabled, empty, secondary info |
| `statusColor(theme, status)` | Map issue/worker status → styled string |
| `priorityBadge(theme, priority)` | `P0`…`P4` with priority-appropriate color |
| `typeBadge(theme, type)` | `epic`/`task` with type-appropriate styling |
| `kv(theme, key, value)` | `key: value` with muted key, normal value |
| `sectionTitle(theme, text)` | Bold/bright section heading |
| `selectionMarker(selected)` | `▸` or ` ` prefix |
| `countBadge(theme, n, label, tone)` | e.g., `3 ready` in success color |

#### 1c. ANSI-safe test utility

Add `stripAnsi(text)` helper (or reuse existing) for test assertions so that
colorized output doesn't break snapshot/substring checks.

### Phase 2: Dashboard Header & Tab Bar

**Goal:** Replace the compressed status/count lines with a structured,
color-coded header.

- **Line 1 (embedded in top border):** `Beadwork Dashboard`
- **Line 2:** Repo path (muted) · activation badge (success/warning) · mode
  badge · scope (accent if scoped, muted if repo-wide)
- **Line 3:** Count summary with colored badges: `3 ready` (success),
  `1 blocked` (error), `2 in-progress` (accent), `1 tracked` (muted)
- **Tab bar (embedded in bottom border or just above it):** `● Issues  ○ Workers  ○ Run  ○ Scope`
  with selected tab in accent, others muted

### Phase 3: Issue Explorer Panel

**Goal:** Colorized, well-spaced issue list with structured detail card.

#### List column
- Selection marker `▸` in accent color
- Issue ID in muted, title in normal, status badge colored by state
- Priority badge `P0`–`P4` with appropriate urgency color
- Type badge `epic`/`task` with distinct styling
- Filter indicator in footer: current filter name in accent

#### Detail column
- Section headings: `Status`, `Owner`, `Dependencies`, `Children`, `Summary`
- Each section uses `kv()` for label:value pairs
- Children listed with bullet `·`, status colored, title truncated
- Description summary in muted/italic

### Phase 4: Worker Manager Panel

**Goal:** Structured worker list with clear state indicators.

#### List column
- Group headers: `▾ Epic BW-100 (current scope)` in accent when scoped
- Worker rows: selection marker, ticket ID, worker status badge (colored),
  ticket status in muted
- Attention-needed workers highlighted with warning background or prefix icon

#### Detail column
- Section headings: `Validation`, `Review`, `Landing`, `Next Steps`
- Check results with pass/fail/pending icons: `✓`, `✗`, `…`
- Refs section: tmux session, log file, worktree path in muted
- Action hints at bottom: `l land` (success if ready), `c cancel` (warning),
  `u cleanup` (muted if ready)

### Phase 5: Run Manager Panel

**Goal:** Clean orchestration status card.

- **Scope section:** Epic ID + title with accent color, or "no epic" in muted
- **State section:** Active supervision in success, idle in muted, with
  stop-reason in appropriate color (completed=success, blocked=error,
  attention=warning)
- **Options section:** Structured `kv()` pairs instead of `key=value` dump
- **History section:** Recent cycles with colored outcome indicators
- **Notes section:** Last 3 notes with timestamps in muted

### Phase 6: Scope Tab

**Goal:** Simple, clear scope display.

- Current scope with accent color or "repo-wide" in muted
- Session info: mode, activation status
- Tracked worker count badge
- Action hints: `s scope from Issues`, `x clear scope`

### Phase 7: Clarify Modals (Delegate & Run)

**Goal:** Align the delegate and run clarify modals with the new visual
language.

- Switch both to rounded borders with embedded title/footer
- Use `kv()` and `styledLabel/Value` for field display
- Selected field gets accent color + `▸` marker
- Validation errors in error color

---

## Test Strategy

### ANSI-Aware Assertions

The existing dashboard tests use substring matching on rendered lines. After
colorization, raw ANSI escape codes will break these assertions.

**Approach:** Add a `stripAnsi()` utility and update test helpers to strip ANSI
before assertion. This keeps tests focused on content correctness rather than
styling.

```typescript
// In test helpers
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// In assertions
const plain = rendered.map(stripAnsi);
expect(plain.some(l => l.includes("3 ready"))).toBe(true);
```

### Existing Test Files

- `src/__tests__/dashboard.test.ts` — integration tests for dashboard with
  snapshot refresh, delegate flow, run flow, scope actions
- `src/__tests__/unit/run-manager.test.ts` — run panel rendering
- `src/__tests__/unit/worker-manager.test.ts` — worker panel rendering

All tests use `createFakeUi()` and `createFakeExtensionContext()` with
`flushAsyncWork()` for async state propagation.

---

## Architecture Notes

### Current Component Structure

```
src/tui/
├── common.ts          — renderSurface, renderTabLine, ANSI helpers
├── dashboard.ts       — main orchestration, tabs, overlay lifecycle
├── issue-explorer.ts  — IssueExplorerController (breadcrumb, filter, detail)
├── issue-detail.ts    — issue detail card renderer
├── worker-manager.ts  — worker list/detail with grouped display
├── run-manager.ts     — run panel summary formatter
├── delegate-clarify.ts — ticket delegation modal
└── run-clarify.ts     — run configuration modal
```

### Key Constraints

- `renderSurface` uses `innerWidth = max(24, width - 4)` and centered borders
- Dashboard overlay: `width: 92`, `maxHeight: 85%`, `margin: 1`
- Worker manager overlay: `width: 110`, `maxHeight: 85%`, `margin: 1`
- Delegate modal: `width: 72`, `maxHeight: 70%`
- Run modal: `width: 76`, `maxHeight: 75%`
- Issue explorer responsive breakpoint at width 88 (two-column vs stacked)
- Worker manager responsive breakpoint at width 92
- Worker visible window: 5 items with "earlier/later" indicators
- Content exceeding `bodyHeight` truncated with `… N more lines` sentinel
- Width-dependent render caching with invalidation on navigation input

### Theme Integration

Content-building functions need to accept the theme object so individual
substrings can be styled before being passed to the renderer. The current
`SurfaceTone` system (`normal | muted | accent | success | warning | error |
selected`) applies tone to entire sections — the refactor needs inline styling
within sections.

### pi TUI API Key Points

- Custom component contract: `render(width)`, optional `handleInput(data)`,
  `wantsKeyRelease`, `invalidate()`
- Each rendered line capped to `width`, styles reset per line
- Overlay API: `width` as `%` or absolute, `minWidth`, `maxHeight`, anchor,
  offsets, margins, `visible()` predicate
- Built-in components: `SelectList`, `SettingsList`, `BorderedLoader`
- Theme: `theme.fg(...)` / `theme.bg(...)`, call `tui.requestRender()` after
  state changes
- Components that cache themed content must rebuild in `invalidate()`

---

## Execution Order

1. **Phase 1** — `tui/common.ts` helpers (foundation for everything else)
2. **Phase 2** — Dashboard header/tabs (most visible improvement)
3. **Phase 3** — Issue explorer (largest surface area)
4. **Phase 4** — Worker manager (complex but contained)
5. **Phase 5** — Run manager (simpler card)
6. **Phase 6** — Scope tab (simplest)
7. **Phase 7** — Clarify modals (standalone, lower priority)

Each phase includes updating the corresponding tests. Run `npm run lint`,
`npm run test`, `npm run typecheck` green before committing each phase.
