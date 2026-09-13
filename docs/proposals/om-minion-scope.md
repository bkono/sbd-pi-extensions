# OM activation scope for Minions

**Status:** Proposed; implementation has not been authorized.
**Scope:** `packages/pi-om-extension` and `packages/pi-minions`.

**Clarification:** Standard Minions launches already exclude the packaged OM
extension for both `spawn` and `orchestrate`. This is a configurability proposal,
not a demonstrated bug where normal minions currently run OM. The wrapper case is
a potential limitation established by reading the path filter, not a reproduced
runtime failure. If normal package loading is the full requirement, making that
existing filter configurable is a valid smaller alternative to the recommended
explicit identity design. The parent custom-message gap is a separate finding and
can be reviewed independently.

## Intent and recommendation

Keep observational memory on the main agent that owns the user conversation, while
delegated minions use ordinary Pi context and native compaction. Make that choice
configurable globally and per project. Both foreground `spawn` and background
`orchestrate` children must behave consistently.

Add one OM setting, `scope: "main" | "all" | "off"`, defaulting to `"main"`.
Minions identifies its child sessions; OM decides whether it should run. Replace
the existing OM filename exclusion with this explicit session boundary.

Also include parent-visible custom messages in OM's observation input. Without
that, the parent can miss the very minion reports it needs to remember.

This is an initial design for review, not a behavior lock or implementation task
graph. Proposed defaults and compatibility choices below need approval before code.

## Current behavior and evidence

- `pi-minions/src/subsessions/manager.ts` creates in-process Pi sessions through
  `defaultCreateChildRuntime`. Both launch paths reach `startChild` and this runtime.
- `MINION_EXTENSION_EXCLUDE_FRAGMENTS` contains both `pi-minions` and
  `pi-om-extension`. `shouldLoadExtensionInMinion` matches substrings of resolved
  paths. OM is therefore already excluded in the normal package layout, regardless
  of configuration. A renamed wrapper can evade that match.
- The installed Pi 0.84.3 loader applies `extensionsOverride` **after** loading
  extension factories. This is a filter on the extension set, not a general
  prevention of module initialization or factory side effects.
- OM initializes lazily through `ensureInitialized` / `ensureRuntime`. Its
  `session_start` creates persistent state unconditionally; other handlers read
  state, observe, inject memory, prune history, or persist state. There is no
  activation setting or child-session check.
- OM already merges defaults, `~/.pi/om-config.json`, `<cwd>/.pi/om-config.json`,
  then environment overrides. Minions has a separate settings surface. Keep OM
  activation in OM's existing config instead of adding a second policy owner.
- Minions writes metadata sidecars after child runtime creation. Those files serve
  history/inspection; they are not currently an early extension activation signal.
- Pi's `SessionManager.appendCustomEntry` and the extension context's read-only
  `sessionManager.getEntries()` provide a session-local metadata channel. Plain
  custom entries are excluded from LLM context by Pi.
- `orchestration/packets.ts` delivers parent reports through `pi.sendMessage`.
  Pi persists these as `custom_message` entries. OM's `getBranchMessages` and its
  separate pre-compaction reader currently select only `type === "message"`.
  Therefore these reports are absent from those observation inputs. This does not
  mean the parent model never sees them; the gap is in OM's branch-based reading.
- OM's `serializeMessage` already has a fallback for custom message roles.
  Its index already imports Pi's `sessionEntryToContextMessages` for native
  compaction-floor preservation.
- Existing orchestration tests protect role prompts from replacement by the parent
  system prompt. Preserve that behavior; do not copy the parent's OM-enriched prompt.

Related context: the orchestration proposal is marked historical. Current runtime
code governs this design. Beadwork has an open OM backlog (`sbdpi-f51`) and a closed
compaction-loop fix (`sbdpi-f51.14`); this proposal does not reopen either or absorb
the broader backlog. No issues are created by this planning pass.

## Configuration and user-visible behavior

Put this in either existing OM config file:

```json
{
  "scope": "main"
}
```

| Scope | Main session | Marked minion session |
| --- | --- | --- |
| `main` (default) | OM active | OM inactive |
| `all` | OM active | OM active with its own session state |
| `off` | OM inactive | OM inactive |

Add `OM_SCOPE` with the same enum and normal precedence:
`OM_SCOPE > project > global > default`. Minions must never set this environment
variable while spawning. It is a user/operator override for the process, not child
identity. Concurrent sessions share `process.env`.

Validate the enum at each config layer. An invalid value should warn with its
source and preserve the lower-precedence valid value. Do not let an invalid project
value erase a valid global `off` or silently enable all sessions.

“Main” means a session without a Minions child marker; it does not mean TUI,
`hasUI`, a particular agent name, or a session without a fork parent. Headless and
RPC main sessions can use OM. A child that coordinates work is still a child.

Resolve settings against each session's `ctx.cwd`, consistent with OM today. An
explicit alternate Minions cwd uses that cwd's project config; parent project
overrides are not implicitly inherited across projects/worktrees. A global `main`
setting applies in either location unless overridden. Do not add Git-root discovery
or a second policy-cwd inheritance system as part of this feature.

Resolve/cache activation per session identity and cwd at session start, with a lazy
fallback for tools/hooks invoked without session start. Reload or start a new
session to pick up file changes. Reset session-specific activation and config when
the same extension instance changes sessions; do not retain the first cwd forever.
No file watcher or live policy toggle is needed.

`/om status` and `om_status` should expose scope, detected session kind, active
state, and disabled reason. Disabled results must not load stored OM data, including
when `om_status` receives another `session_id`. `/om observations` and
`om_observations` return a disabled explanation, with no state read. `/om:toggle`
cannot override scope; explain which config enables the session.

The existing diagnostic tools may remain registered. Their disabled execution
path is side-effect-free. Hiding tools dynamically is not required for this slice;
Minions reapplies active-tool lists after binding, so tool visibility alone would
not be a reliable activation boundary anyway.

## Session identity contract

In `defaultCreateChildRuntime`, immediately after `SessionManager.create` and
before resource loading, session creation, extension binding, or the first prompt:

```ts
sessionManager.appendCustomEntry("pi-minions:session", {
  version: 1,
  kind: "subagent",
});
```

This is a proposed new contract using an existing, verified Pi API. It needs no
runtime import from OM into Minions, no import from Minions into OM, and no shared
package. Keep the two small producer/consumer definitions aligned with a contract
fixture test. The marker identifies session origin, not mutable execution status.

Read the marker from session entries before OM runtime initialization. Do not use
only the prompt messages, and do not infer identity from filesystem paths or role
prompt text. A recognized marker with invalid data or an unknown version yields
an unknown-child classification: disable under `main` and report the reason. An
absent marker preserves ordinary main-session behavior. `all` explicitly permits
either kind; `off` permits neither.

The marker is durable, so reopening a newly created child retains its classification
even in a TUI. A branch retaining the marker remains a child; a fresh user session
without it is main. This is an explicit proposed semantic choice, not a claim that
UI mode can establish ownership. Validate persistence and branch behavior using
real Pi SessionManager fixtures before locking it.

Existing Minions sidecars remain unchanged for inspection. Do not copy their task,
status, and orchestration fields into the activation marker. They describe a
different concern. No OM-state schema migration is needed.

## Activation boundary inside OM

Separate cheap config/identity resolution from creation of `ObservationAgents`.
One resolver should return the effective scope, session kind, active boolean, and
reason. Lifecycle handlers and commands/tools use that resolver before reaching
state or runtime initialization.

For inactive sessions, require all of the following:

- No observer/reflector construction or calls, credential resolution, token-window
  processing, or OM state reads/writes.
- No system-prompt injection, observation publication, or history pruning.
- No forced observation before compaction; return control to normal Pi compaction.
- No state persistence on shutdown, including after a disabled status query.
- Existing state is left on disk and cannot be injected or exposed through tools.

This is distinct from `paused`. Paused OM currently skips cycles/pruning but can
still load state and inject published observations. Do not use pause as the child
disable mechanism. Active-session pause semantics remain unchanged.

Once this boundary and the child marker are in place, remove **only** the
`pi-om-extension` fragment from Minions' exclusion list. Keep the `pi-minions`
exclusion and the existing child tool restrictions. Keeping the OM exclusion as a
fallback would make `scope: "all"` ineffective in the normal package layout.

Loading inactive OM still incurs module import/factory registration costs. This
design eliminates OM runtime work, not every byte of extension loading. Do not
claim otherwise or add a loader framework to avoid that small fixed cost.

## What the parent remembers

The parent observes its own conversation, including spawn tool results and
delivered orchestration lifecycle/messages. It does not read child transcripts or
merge child OM files. Child findings are evidence; the parent remains responsible
for adjudication and reporting decisions. Reports omitted/truncated by Minions are
not magically recoverable through OM.

Introduce one shared branch-to-observation projection for normal hooks and forced
pre-compaction observation. Select `message` and `custom_message` entries, and use
Pi's `sessionEntryToContextMessages` to convert those selected entries. Preserve
order and the cursor/timestamp conventions used by existing observation logic.

Do **not** flatten every entry type indiscriminately: that API also projects
`compaction` and `branch_summary` entries. Including summaries in this change
would expand scope and risk re-observing synthetic summaries. Plain `custom`
metadata, including the role marker, must never enter observer input.

Add a realistic lifecycle packet regression proving the content reaches the
observer, is retained before publication, and is prunable only after its published
memory is available. Include repeated/equal-timestamp cases to verify current cursor
fallbacks do not skip reports. Preserve the existing native-compaction floor,
tool-call/result pairing, published-versus-draft cursor rules, and context budgets.
If this exposes a cursor defect, fix the demonstrated case without redesigning
OM's entire message model.

## Alternatives and tradeoffs

| Approach | Benefit | Why not the recommendation |
| --- | --- | --- |
| Configurable Minions filename filter | Smallest diff; extends today's behavior | Policy remains coupled to package paths; wrapper coverage is weak; OM cannot explain its disabled state |
| OM scope plus explicit session marker | One policy owner; works through wrappers; session-local and testable | Requires coordinated changes in both packages and inert OM registration in children |
| Process env, prompt text, or UI-mode detection | Superficially easy | Env races across in-process sessions; prompt/UI signals do not establish main versus child identity |

No general extension capability registry, dependency-injection framework, shared
memory service, transcript merger, or upstream Pi patch is needed for v1.

## Implementation sequence and likely files

1. **Lock semantics after review:** enum/default, alternate-cwd behavior, resumed
   child classification, and the limited custom-message observation change.
2. **OM config and activation:** update `src/types.ts`, `src/config.ts`, a small
   `src/activation.ts`, and `src/index.ts`; extend `src/format.ts` for diagnostic
   output. Add precedence, classification, inactive lifecycle/tool, and reset tests.
3. **Minions marker:** update `src/subsessions/manager.ts` to append metadata before
   resource loading. Add a fixture around the production runtime construction path.
4. **Cutover:** delete the OM exclusion fragment and update
   `src/__tests__/spawn-helpers.test.ts`. Prove both spawn/orchestrate use the marker
   and that a differently named wrapper cannot activate OM under `main`.
5. **Parent report coverage:** share the selective entry projection in OM's index;
   add custom-message lifecycle, publication, cursor, and compaction regressions.
6. **Documentation and release:** update both package READMEs with config, reload
   semantics, supported package pairing, and limitations. Run all gates and commit
   behavior-scoped changes. Create/close implementation issues only after approval.

These production seams are confirmed by inspection. A separate activation module
and new test filenames are proposed organization, not existing APIs. The current
Minions tests often inject fake runtimes; those alone cannot prove marker timing
inside `defaultCreateChildRuntime` or actual loader behavior.

## Validation and acceptance

Use fake observation agents/auth for deterministic automated tests; no live LLM
credentials are required for acceptance. At least one test must use the real Pi
resource loader/session binding and concurrent parent/child sessions, rather than
only the existing OM single-extension harness.

- Config: all three enum values, default, global/project/env precedence, invalid
  overrides, alternate cwd, and refreshed activation after session changes.
- Default main: parent still observes/publishes/injects; several children do none
  of those, including forced compaction and shutdown. Assert no child OM state.
- All: children can load OM and use independent session IDs/files. Off: neither
  parent nor child initializes OM. Model/provider settings keep existing precedence.
- Existing child OM state: no injection, reads, writes, or exposure through explicit
  status queries while disabled. Toggle cannot bypass policy.
- Loading: packaged OM and a renamed wrapper behave identically; first
  `session_start` sees the marker; minions itself stays excluded.
- Persistence: real SessionManager round-trip and branch fixtures retain identity
  where promised. Ordinary user forks without a marker remain main.
- Parent evidence: realistic foreground results and custom lifecycle packets reach
  observation input once per relevant cursor window. Marker/synthetic summaries do
  not. Publication and native compaction regressions continue to pass.

Run before implementation closure and commits:

```sh
npm run lint
npm run test
npm run typecheck
npm run build
```

Manual acceptance after implementation: set global `main`, launch one foreground
and two concurrent orchestrated minions, inspect parent OM status and state files,
and force child native compaction with a deterministic test host. Repeat with
project `all`, then project `off`; remove overrides to confirm fallback. A real
provider smoke test is optional confirmation, not a substitute for hook assertions.

## Compatibility, risks, and open questions

- Default `main` preserves today's standard main/minion behavior. It newly blocks
  wrapper-loaded OM when child identity is present, which is intentional.
- Ship the marker, OM guard, and filter removal together. New Minions plus old OM
  would activate unguarded OM in children; new OM plus old Minions would still
  filter packaged OM even under `all`. Document the supported version pair rather
  than adding a runtime negotiation protocol.
- Historical minion files have no marker. This v1 does not migrate them or infer
  identity from paths/sidecars. Manually reopening one is treated as unmarked/main;
  use `off` if needed. Minions does not auto-resume those historical workers today.
- Third-party subagent launchers are not detected automatically. They would need
  an explicit contract in a later integration; `main` is not a universal detector.
- Resuming a marked child interactively still disables OM under `main`. If Bryan
  wants “currently user-owned” instead of persistent child origin, that requires
  an explicit promotion semantic and should be settled before implementation.
- Alternate worktrees use their own cwd config. If policy must follow the parent
  regardless of execution cwd, review that requirement explicitly before adding
  inheritance; do not silently change existing OM config lookup.
- Activation is application behavior, not a security boundary. Same-process
  extensions and shell access are trusted; this does not isolate data from hostile
  code. Disabled OM itself must still avoid reading other session memory.
- Root lifecycle-packet observation needs a regression with actual persisted entry
  shapes. Existing helpers centered on ordinary messages cannot establish this.

## Handoff

- **Summary:** Proposed configurable OM activation, explicit child identity, and
  inclusion of parent-visible custom messages in observation input.
- **Decisions proposed:** OM owns `scope`; Minions owns the child marker; default
  `main` retains normal behavior. Native Pi compaction handles disabled sessions.
- **Closed doors:** No env mutation, prompt/UI detection, transcript merger, pause
  workaround, new policy store, or general extension registry.
- **Invariants:** Parent/child state stays separate; disabled means no OM state I/O
  or context changes; published memory precedes pruning; native compaction remains
  Pi-owned; no automatic parent prompt inheritance.
- **Dead code / deprecated:** Proposed deletion of the `pi-om-extension` exclusion
  fragment at coordinated cutover. Keep the `pi-minions` exclusion. No code deleted
  in this planning pass.
- **Validation:** Source inspection grounds this proposal; implementation acceptance
  and exact commands are above. Planning-pass gate results are recorded below.
- **Status:** Proposal ready for review; no implementation or issue mutations.
- **Next steps:** Review the compatibility/ownership choices, approve the behavior
  subset, then track and implement the sequence above.
- **Risks / open questions:** Mixed versions, historical unmarked sessions, explicit
  alternate cwd, interactive child promotion, and custom-message cursor coverage.

Planning-pass checks: `npm run lint` and `npm run typecheck` passed. The first
`npm run test` was blocked by sandbox permissions creating Minions test fixtures
under `~/.pi/agent/sessions`; rerunning with that filesystem access permitted
passed all 444 files / 2,382 tests. These are baseline checks, not proof of the
unimplemented feature. No production code or tests changed.

## Evidence index

All source paths below are relative to the repository root:

- `packages/pi-minions/src/subsessions/manager.ts`: exclusion list,
  `defaultCreateChildRuntime`, `startChild`, extension binding, sidecar writes.
- `packages/pi-minions/src/subsessions/types.ts`: injectable child runtime boundary.
- `packages/pi-minions/src/spawn.ts` and `src/index.ts`: child launch/session ownership.
- `packages/pi-minions/src/orchestration/packets.ts`: `submit` and `sendMessage`.
- `packages/pi-minions/src/config.ts`: separate Minions settings ownership.
- `packages/pi-minions/src/__tests__/spawn-helpers.test.ts`: current exclusion test.
- `packages/pi-minions/src/__tests__/orchestrate.test.ts`: role prompt preservation.
- `packages/pi-om-extension/src/index.ts`: lifecycle hooks, branch projection,
  initialization, diagnostics, pause behavior, and compaction-floor preservation.
- `packages/pi-om-extension/src/config.ts`: existing precedence and config paths.
- `packages/pi-om-extension/src/tokens.ts`: custom-message serialization fallback.
- `packages/pi-om-extension/src/engine.ts`: observation input and cursor/publication.
- `packages/pi-om-extension/src/__tests__/unit/config.test.ts`: configuration fixtures.
- `packages/pi-om-extension/src/__tests__/helpers/extension-harness.ts`: current
  single-extension mock and its integration limits.
- `packages/pi-om-extension/src/__tests__/extension/lifecycle-session-before-compact.test.ts`:
  native compaction regression pattern.
- Both package READMEs; `docs/proposals/beadwork-minions-orchestration.md` (historical).
- Installed Pi 0.84.3 `dist/core/resource-loader.js`, `extensions/types.d.ts`,
  `session-manager.{js,d.ts}`, and `agent-session.js`: verified loader ordering,
  metadata API, custom-message persistence/projection, and context interfaces.
