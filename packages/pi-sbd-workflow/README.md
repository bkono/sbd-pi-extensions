# @solvedbydev/pi-sbd-workflow

The Pi side of the sbd workflow. The router, playbooks and principles are skills from
`sbd-mastra-factory` (its `pi` manifest); this package adds only what skills cannot do.

## What it adds

| Piece | Behavior |
| ----- | -------- |
| `sbd_set_predicate` | Sets the session's done-predicate and records each covered repository's HEAD as its base. Parent-only: no minion gets it. |
| Done gate | At `agent_before_settle`, a covered repository with new commits needs a passing independent verdict at HEAD and no uncommitted changes (tracked or new files), unless it was already dirty when the goal was set. Otherwise Pi continues the run with the reason, at most 3 times; then it settles without claiming done and keeps the goal until the user speaks. Nothing committed yet means settle and keep the goal. A met goal clears. Calling `sbd_set_predicate` again rewords the goal or adds repositories; covered bases never reset. |
| Yield while minions run | The gate never continues while pi-minions reports live orchestrated children. Their packets wake the lead. |
| `sbd_verdict_post` | Injected only into `verifier` children. Refuses unless run against a linked worktree at the SHA with no tracked edits. Writes the same record and store as `sbd-verdict post` (`~/.local/state/sbd-workflow/verdicts`, or `SBD_VERDICT_HOME`), so `sbd-verdict check` reads it. |
| Shell guard | Blocks `gh pr merge` always (humans merge) and `gh pr ready` until HEAD has a passing verdict. It matches command text. |
| Task list | `task_write`, `task_update`, `task_complete`, `task_check`, ported from Mastra Code: stable ids, one task in progress, a TUI widget. Lead-only. State lives in tool-result details, so `/tree` and forks carry it. When observational memory or compaction drops the latest list from model context, a hidden `<current-task-list>` snapshot is appended at the next turn boundary, after OM's own edits, so it adds no cache break and never edits the system prompt. |
| Agents | `sbd-worker` (build mode), `reviewer` (plan, pack-only), `verifier` (fast, pack-only, independent), contributed to pi-minions. |
| Router pointer | In any session that loaded the hidden `sbd` skill, a `sbd_workflow` prompt section names the router and principle-leaf paths, so delegates can read them. |

## Setup

Requires `@solvedbydev/pi-minions`. The reviewer and verifier run only on the pack's `plan` and
`fast` models. Without settings they default from the available models (pi-minions README,
Configuration): with Anthropic and OpenAI, Terra verifies and the reviewer takes the family opposite
the writers'. To pin them:

```json
{
  "pi-minions": {
    "modes": {
      "plan": "anthropic/claude-opus-5-5",
      "build": "openai-codex/gpt-6.1-sol",
      "fast": "anthropic/claude-fable-5-2"
    }
  }
}
```

Load the skills by adding the `sbd-mastra-factory` checkout as a Pi package. Start work with
`/skill:sbd <task>`.
