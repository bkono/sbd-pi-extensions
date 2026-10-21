# Dependency Upgrade Log

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
