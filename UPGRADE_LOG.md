# Dependency Upgrade Log

## 2026-11-11 — Pi 1.5.2 (sbdpi-jpz)

### Summary

- Updated the root exact pins for `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent` and `pi-tui` from `1.3.0` to `1.5.2`. Dev and test runs now match the installed Pi, and its catalog includes `openai-codex/gpt-6.1-terra`, which pi-om's auto chain now prefers.
- TypeBox stays at `1.3.27`, which is Pi 1.5.2's own dependency.
- Adapted two contract changes:
  - pi-minions: `MessageRenderOptions` now extends `KeybindingHints`.
  - pi-hashline-readmap: the builtin grep keeps lone CRs in match lines.

### Decisions made

- **Release unit.** Upgrade the four Pi packages together, as with 1.3.0. `npm ls` confirms every workspace resolves 1.5.2.
- **pi-minions.** `renderResult` forwards `keyText` and `keyHint` from Pi's tool render context into the spawn renderer's options. When a caller passes none (tests), it falls back to an empty key and a bare description. It does not fabricate keybindings.
- **pi-hashline-readmap, grep parsing.** The match and context regexes take `[^\n]*` for the text group, because `.` does not match `\r`. Without this, every bare-CR match line failed to parse, and hashline passed Pi's raw output through with no anchors. The bare-CR remap already re-reads the file, so it is unaffected.
- **pi-hashline-readmap, prompt-metadata test.** The test compares active tool names as a set. Pi 1.5 orders active tools itself, and the test's subject is snippet and guideline delivery, which order does not affect.

### Closed doors / Do Not

- Do not mix Pi release versions. Do not change the TypeBox pin away from Pi's dependency.
- Do not reintroduce `.` for grep text groups.

### Validation

From the repository root:

- `npm run lint`, `npm run typecheck`, `npm run build`: pass.
- `npm run test`: 410 test files, 2137 tests pass.
- `npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui typebox --all`: one version everywhere (1.5.2; typebox 1.3.27).
- `npm audit`: 13 findings (7 high, 5 moderate, 1 low).
  - **Removed by this upgrade:** Pi's `minimatch` finding. `pi-coding-agent` 1.3.0 pinned `minimatch@10.2.6`; 1.5.2 uses `11.0.3`.
  - **Not introduced by this upgrade:** the `zod` finding comes through `openai@7.19.0`, which `pi-ai` pins in both 1.3.0 and 1.5.2.
  - **The rest** are Vite, Vitest, esbuild and postcss tooling, `exa-js`, and `ts-morph`. They sit outside this upgrade's scope.
- Live: pi-om v2 ran on Pi 1.5.2 with a gpt-6.1-terra observer (doc §14 of pi-om).

### Risks / Open questions

- Lockfiles remain untracked, so transitive resolutions may differ on a fresh install.
- `pi-hashline-readmap`'s package-version test reads the gitignored `package-lock.json`, so it fails in fresh worktrees.

### Sources

- [Pi coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/CHANGELOG.md) (1.4.0–1.5.2 entries; read from the installed package).

## 2026-10-21 — Pi 1.3.0 (sbdpi-hkg)

### Summary

- Updated the root exact pins for `@earendil-works/pi-agent-core`, `pi-ai`,
  `pi-coding-agent`, and `pi-tui` from `0.84.3` to `1.3.0`.
- Updated TypeBox and its override from `1.3.7` to `1.3.27`, matching Pi's dependency.
- Adapted Minions' start hook, Beadwork's shared goal-start context types, and
  provider/verification test adapters to the released contracts.

### Decisions made

- Upgrade the Pi packages as one release unit: their internal dependencies are
  exact pins in 1.3.0. `npm ls` confirms all workspaces share the same versions.
- Delegation hints apply only to user starts. Custom-message starts must neither
  read a nonexistent prompt nor consume the hint interval or accumulated tool count.
- Shared goal activation accepts `ExtensionContext`; command entry points retain
  `ExtensionCommandContext`. Tool execution must not pretend to have session-control
  methods available only to commands.
- Provider tests read prompt and tool state from `TranscriptContext.messages` using
  `getCurrentSystemPrompt()` and `getCurrentTools()`. Assertions preserve fixture
  data and lifecycle behavior without freezing production guidance wording.
- Regenerated the local lockfile; it remains untracked under the repository's
  existing `.gitignore` policy. No package-lock tracking policy change is included.

### Closed doors / Do Not

- Do not mix Pi release versions or restore the TypeBox 1.3.7 override.
- Do not access `before_agent_start.prompt` without checking the user discriminant.
- Do not restore the tool-to-command context cast or the provider test's old
  `context.systemPrompt` access.
- Do not expand this change into unrelated tooling updates or orchestration redesign.

### Invariants

Child delivery, settlement, retry, and abort behavior remain covered by the existing
suite. User prompts still receive delegation hints when eligible; custom starts do
not. Runtime Pi packages remain external in extension builds. Node remains `>=24`.

### Dead code / deprecated

Removed the tool-to-command cast and obsolete provider-context access. Their
replacements are the common context contract and normalized transcript helpers.
No replacement orchestration path or compatibility wrapper was introduced.

### Validation

Commands run from the repository root:

```sh
npm run lint
npm run test
npm run typecheck
npm run build
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui typebox --all
npm audit --json --cache /tmp/sbdpi-npm-cache
```

- Baseline: lint, typecheck, and all 2,289 tests passed.
- Regression: the new custom-start test reproduced the missing-prompt crash before
  the guard and passed afterward. Focused lifecycle/provider tests pass.
- Full post-upgrade validation: lint and typecheck pass; 432 test files and all
  2,290 tests pass; all seven workspace builds pass. Beadwork's build was also
  rerun after the final shared-context type adjustment.
- Audit: 13 findings reduced to 7 (4 high, 2 moderate, 1 low); no new advisory IDs.
  Remaining findings concern existing Vite/Vitest/esbuild and related tooling
  dependencies. The baseline critical finding is gone.
- Tests require filesystem access outside the sandbox: existing Minions paths use
  `~/.pi/agent/sessions` directly and ignore `PI_CODING_AGENT_DIR`.

### Status / Next steps

Done. No remaining implementation steps. Any remediation of the unrelated tooling
audit findings is a separate follow-up.

### Risks / Open questions

Seven existing audit findings remain outside this upgrade's scope. Build plugin
timing warnings are informational. Live paid-provider smoke tests are not part of
this validation; the integration suite exercises Pi with a deterministic provider.
Untracked lockfiles mean transitive resolutions may differ on a fresh install.

### Sources

- [Pi coding-agent 1.3.0 changelog](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md)
- [Pi AI 1.3.0 changelog](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/CHANGELOG.md)
- [Pi agent-core 1.3.0 changelog](https://github.com/earendil-works/pi/blob/v1.3.0/packages/agent/CHANGELOG.md)
- npm release metadata and installed declarations for the pinned versions.
