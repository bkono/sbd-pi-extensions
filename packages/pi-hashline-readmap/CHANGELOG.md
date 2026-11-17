# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Changed
- `edit` guidelines tell the model not to re-read to verify an edit (the file holds exactly what was sent; the result shows changed regions, abridged when long, and says when it leaves one out), and that anchors still visible to it for lines its edit did not replace or delete usually keep working (any anchor that no longer matches exactly one line, such as a duplicate-text line after a shift, is refused with nothing written). The whitespace-only warning no longer says to re-read; it says only indentation or spacing changed. Hashline eval (t3-feature, t6-long-session; arms compared only when run concurrently, since cost drifted about 10% between sessions on identical code; cost is Pi's rate-card figure; exact Mann-Whitney p): on Opus 5.5 against no guidance (5 runs per arm), cost −28% on t3 (p=0.03) and −8.8% on t6 (p=0.31), stale-anchor refusals 4 → 5 on t6. Against an earlier wording that promised held anchors "stay valid after your own edits" (5 runs per arm), stale or ambiguous refusals on t6 fell from 8 to 1 (p=0.02) and cost fell 7.8% (p=0.10), though reads after an edit rose from 8.6 to 12.8. On GPT-6.1 Sol (3 runs per arm) no metric moved significantly: cost +18% on t3 (one run with a provider cache miss) and −3.2% on t6. Every run passed all hidden tests. In 2 of 26 runs the model sent a malformed anchor for a line it had not read (`145:`, `90:XXX`); each was refused before anything was written.
- `edit` items are flat: `{ "op": "set_line", "anchor": "…", "new_text": "…" }` (also `replace_lines`, `insert_after`, `replace`) instead of `{ "set_line": { … } }`. The nested shape put two closing braces at the end of every call; Opus dropped one in 4 of 10 eval runs when `new_text` contained braces (`});`), so Pi could not parse the call. Flat items had 0 in 10 runs. Programmatic callers may still pass the nested shape; the TUI preview and edit counts read both.

### Fixed
- Anchored edits are written exactly as sent. The engine's vendored repair rules are removed: range-boundary echo stripping (dropped a last or first `new_text` line that matched the next or previous file line, ignoring whitespace), insert-anchor echo stripping, wrapped-line restoration, single-line merge expansion, and indent restoration. A replay of about 470 edits from the hashline eval found 6 firings, every one harmful: five dropped a closing line the code needed (`    }` before `  }`, `    });` before `  });`), leaving broken code the model only found through a test failure, and one removed a deliberate blank line. A copied `LINE:HASH|` prefix is still stripped, but only when its hash matches the rest of its own line, so data like `10:45|standup` or `100|a2` is kept. Leading `+` is no longer stripped (Markdown lists, diff files).
- Overlapping anchored edits in one request are refused with `overlapping-edits` instead of corrupting the file (for example `replace_lines 1-3` plus `set_line 2` used to delete line 4). Conflicting edits to one line are refused rather than "last wins". An `insert_after` on a replaced line goes right after that replacement's lines. Several `insert_after` edits on one line apply in request order (they came out reversed).
- An unchanged line containing an en dash, em dash or minus sign is a no-op; it used to be rewritten with ASCII `-`.

### Changed
- `write` returns a one-line summary (`Created <path> (N lines).`) instead of echoing the whole file as `LINE:HASH|` lines. The model wrote the content, so the echo cost about 1.15x the file size in context on every later request. It issues no anchors: an anchored `edit` after `write` needs a `read`, a text `replace` does not. `ptcValue.lines` still carries every anchor for programmatic callers.

### Removed (model-facing schema)
Cut from the tool definitions sent on every request, from usage across 1,050 hashline sessions (2026-04 to 2026-11): about 1,812 → 1,408 tokens per request. `execute()` still accepts each for programmatic (PTC) callers.
- `ast_search` is no longer offered to the model (6 calls in 7 months); its executor stays in `__hashlineToolExecutors`.
- `edit`: the `replace_symbol` variant (20 calls, 15 failed), `replace.fuzzy` (0), `insert_after.text` (3), the legacy `{old_text,new_text}` item (13 calls, all rejected by design), and the repeated `additionalProperties: true` (Pi's validator allows extra keys without it).
- `find`: `regex` (1), `modifiedSince` (4), `minSize` and `maxSize` (0).
- `grep`: `scope` and `scopeContext` (55 calls, `scopeContext` failed 46%).
- `write`: `map` (60 calls, none since 2026-06-03).

### Changed
- `edit` checks freshness per anchor, not per file. An anchor ledger (`src/anchor-ledger.ts`) records every `LINE:HASH` shown by `read`, `grep`, `ast_search`, `write` and `edit`, and carries each one through the edit tool's own edits by tracking every splice it makes (replace_symbol, anchored edits, text replace), never by a content diff, which slides across identical lines. An anchor the model already holds for an unchanged line keeps working under the line number it was copied with, so a follow-up edit to the same file no longer needs a re-read. A change made outside `edit` (file stamp moved, or a detected shell mutation) clears the file's anchors.
- `edit` results now end with fresh anchors for each changed region and two lines of context (long regions show head and tail, 48 lines at most).
- An anchor that was not issued for the current content fails with the new `stale-anchor` code and shows the current lines near it with anchors. A hash match alone no longer passes: the hash covers one whitespace-stripped line in 12 bits with no line number, so a shifted `}` or blank line used to verify.
- When a carried anchor's key collides with a line shown later under the same key (common for `}` and blank lines), neither wins silently. The next use is refused once, naming the moved line's new anchor; after that refusal the key means its own line.
- With the ledger, `edit` no longer relocates anchors by hash: anchored lines move exactly past `replace_symbol` splices, and a mismatch is refused. Read stamps the file before reading and also issues the `ptcValue` lines past the text's truncation.

### Removed
- The "Edit changed N lines across M operations — verify no unintended reformatting" warning. It counted changed lines by position, so any mid-file `insert_after` counted every later line and fired on correct edits.
- File-level `readTurns` expiry in `index.ts`; the ledger replaces it. `registerEditTool` still accepts `wasReadInSession` for an edit tool registered without a ledger.

## [0.8.16] - 2026-05-28

### Changed
- Tree-sitter mappers (`rust`, `cpp`, `java`) now share their low-level helpers (`normalizeWhitespace`, `getNodeText`, `getLineRange`, `findFirstDescendant`, `finalizeSignature`) via `src/readmap/mappers/tree-sitter-helpers.ts`. Behavior-preserving refactor; structural-map output shape is unchanged. `MAPPER_VERSION` bumped (rust 2→3, cpp 2→3, java 3→4), which invalidates persistent-map cache entries for the affected languages on first read (#202, PR #135).
- `write` tool now carries an explicit inline `ptc` policy (mutating, not safe by default) and is registered in `HashlineToolName` and `HASHLINE_TOOL_PTC_POLICY`. The PTC drift guard test was replaced with a mechanical check that cross-references each live tool's inline `ptc` against the exported policy and emitted executor map, so a tool added without a policy entry now fails CI (#201, PR #134).

### Removed
- Dead `BASH_FILTER_ENABLED = true` constant and its unreachable branch in `index.ts`; the live `filterBashOutput` path is unchanged (#200, PR #133).

### Fixed
- TUI renderer tests for the collapsed-diff default (`edit-render-tui.test.ts`, `edit-pending-diff-render-success.test.ts`) are now isolated from the user's real `~/.pi/agent/hashline-readmap/settings.json`, so a machine configured with `edit.diffDisplay: "expanded"` no longer produces false test failures (#200, PR #133).

## [0.8.15] - 2026-05-25

### Changed
- Release 0.8.13: Rust, C++, Java, and edit syntax validation now use `web-tree-sitter` with packaged `tree-sitter-wasms` grammars instead of native `tree-sitter*` packages. Native grammar dependencies were removed and unsupported Clojure mapper support was dropped (#192).
### Fixed
- `ast_search`: when the bundled `@ast-grep/cli` binary cannot be resolved, the PATH fallback now prefers `ast-grep` over `sg`, avoiding the `sg: group 'run' does not exist` error caused by util-linux's setgid `sg` on Linux. Thanks to @Ramblurr for the original investigation in [GH #112](https://github.com/coctostan/pi-hashline-readmap/issues/112) and PR #113.
- `readmap` mappers (`python`, `go`, `fallback`, `json`, `ctags`) now invoke subprocesses via `execFile` or in-process scanning instead of shell `exec`, so paths containing shell metacharacters (`"`, `` ` ``, `$`, `;`, `|`, `&`, newline) no longer break quoting or produce null maps ([GH #116](https://github.com/coctostan/pi-hashline-readmap/issues/116)). Each migrated mapper now carries a comment forbidding `exec`-with-template to prevent regressions.
- TUI diff renderer: pending `write`/`edit` previews now include `+`/`-`/space textual markers in the gutter (`▌+ `, `▌- `, `▌  `) in addition to color, so add/remove rows are distinguishable in plain-text transcripts, screenshots, and screen readers ([GH #190](https://github.com/coctostan/pi-hashline-readmap/issues/190)).

## [0.8.2] - 2026-04-30

### Fixed
- Harden Bash recoverability by validating Pi full-output paths before reading them and by preserving original/pre-RTK snapshots when the Bash context guard trims without a valid Pi original path.
- Preserve recoverability metadata when trim-time original snapshot writing fails.

### Docs
- Document the Bash context guard variables, default-on policy, `PI_HASHLINE_BASH_CONTEXT_GUARD=0`, raw-byte/positive-integer parsing, clamp/fallback semantics, and `PI_RTK_BYPASS=1` interaction.
- Record the release instruction to bump the package number whenever the Bash guard contract docs/release notes are updated.

## [0.8.0] - 2026-04-28

### Added
- Opt-in `grep` final output budget controls via `PI_HASHLINE_GREP_MAX_LINES` and `PI_HASHLINE_GREP_MAX_BYTES`; values can only tighten existing defaults and invalid values fall back safely.
- Phase 0 context-hygiene metadata for read, search, command-output, and mutation tool results, including an opt-in `context_hygiene_report` debug tool behind `PI_CONTEXT_HYGIENE_DEBUG=1`.
- Stale-context contract foundations for mutated-file context tracking and downstream context replacement work.

### Fixed
- `edit`: restore the default shell rendering path.
- `edit`: preserve blank lines in `replace_lines` wrapped-line restoration.
- Structural map cache: validate content hashes on in-memory cache hits to avoid stale maps.

### Docs
- Refresh README configuration, context-hygiene, release, and documentation links for the current codebase.
- Update exploratory functional testing notes for the current suite size and coverage areas.

## [0.7.0] - 2026-04-20

### Added
- Anchor-contract prompt/docs alignment (#42).
- Surface edit semantic annotations + replace-only guidance (#43).
- Require confirmation for fuzzy symbol matches (#44).
- `grep` `scopeContext` windowing (#45).
- `find` regex pattern, `modifiedSince`, `minSize`/`maxSize`, `sortBy`/`reverse` options (#46).
- Expose `ls` / `find` hashline executor surface (#47).
- Structured `ptcValue` error envelopes (#49).
- Doom-loop escalate from warning → append-then-review in `edit` (#50).
- Bash compression raw-bypass via `PI_RTK_BYPASS=1` (#51).
- Persistent structural-map cache across sessions (#52).

### Fixed
- `find`: validate `maxDepth` ≥ 0 before spawning `fd` (#112).
- `read`: reject empty / whitespace-only `symbol` instead of silently returning full file (#113).
- `ls`: validate `limit > 0` and surface invalid-glob errors (#114).
- `ast_search`: report `path '<x>' does not exist` instead of silent "No matches" (#115).
- `write`: map `EACCES`/`EPERM`/`EISDIR`/`ENOENT`/`ENOSPC`/`EROFS` to friendly messages (#116).

### Docs
- `AGENTS.md`: correct extension-loading description (absolute-path entry in `~/.pi/agent/settings.json`, not a symlink) and note the restart requirement for running sessions (#117).
- `README.md`: document persistent map cache, `scopeContext`, new `find` filters, `PI_RTK_BYPASS`, edit semantic summaries, and fuzzy-symbol confirmation banners (#118).

## [0.4.0] - 2026-03-24

### Added
- Semantic edit summaries for `edit`, including additive structured metadata and optional difftastic-backed classification.
- Additive output-contract metadata for `read` local bundles and `grep` symbol-scoped results.
- Render helpers / richer TUI rendering for `read`, `grep`, `edit`, and `sg` tool output.
- Additional RTK compressors and routing improvements for Docker, package managers, HTTP clients, transfer tools, and file-listing commands.
- EventBus / global executor exposure for downstream consumers.
- Public PTC policy / structured output integration for hashline tools.

### Changed
- Repo metadata and docs were cleaned up for the `0.4.0` release.
- README and local agent guidance were refreshed.

## [0.3.0] - 2026-03-16

### Added
- Symbol-addressable reads via `read(path, { symbol })`, including ambiguity handling and graceful fallback warnings.
- Bash output compression filter wired into the extension tool-result flow.
- Faster hash generation via `xxhash-wasm`.
- Lower-syscall `read` / `edit` file access paths.
- Grep output summary headers, smarter truncation, and context-window deduplication.
- AST-grep range merging to reduce duplicate output blocks.
- Compact single-line edit diffs.

### Changed
- README and release metadata were updated for the `0.3.0` release.

## [0.2.0] - 2026-03-03

### Added
- Unified project scaffold combining hashline read/edit/grep behavior, structural read maps, and RTK bash-output compression foundations.
- Core source layout under `src/`, `src/readmap/`, `src/rtk/`, `scripts/`, `prompts/`, and `tests/`.
- Initial Vitest suite and TypeScript project configuration.

## [0.1.0] - 2026-03-02

### Added
- Initial local development baseline for the combined extension workspace.
