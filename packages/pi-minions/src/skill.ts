export const MINIONS_SKILL = `# pi-minions

Use minions when independent work can run in isolated agent sessions.

- Use \`spawn\` when you intend to wait. Provide \`task\`, optional \`agent\`, and optional \`model\`. The tool blocks until the minion completes and returns its result. Use a \`tasks\` array for parallel foreground minions. Spawn is not in an orchestration group and does not emit parent lifecycle packets.
- Use \`orchestrate\` for background work that should not block this turn. It returns handles immediately; results arrive later as coalesced parent packets. Persistent hosts only (\`tui\` / \`rpc\`).
- Each orchestrated task requires \`task\` (complete child prompt; not wrapped) and \`description\` (short fleet label; do not infer from \`task\`). Optional: \`agent\`, \`taskType\`, \`model\`, \`domain\`.
- \`agent\` is a discovered agent/template name (same loader as spawn). Built-in \`worker\` and \`investigate\` are always available and overridable. Call \`list_agents\` if unsure. Not a closed enum.
- \`taskType\` is closed: \`implementation\`, \`fix\`, \`reviewImplementation\`, \`reviewScope\`, \`investigateBlocker\`. Omit for untyped work. It selects parent nudge text when the child settles, fails, aborts, or asks. Never collapse agent and taskType.
- One open group per parent session. Omit \`groupId\` to create it or join the open group. A second group is rejected. \`cwd\` is group-create only, must already exist, and cannot change later.
- Use \`list_agents\` before selecting named agents when you are unsure what is available.
- Use \`halt\` with a minion id, name, group id, \`group\`, or \`all\` to abort running minions. Halt of a group forgets the open orchestration group so the next orchestrate creates a new id. Halt does not exit Beadwork goal mode.
- Use \`list_minions\` to see spawn vs orchestrated minions, including agent, taskType, group, last said, and peer-message failures.
- Use \`show_minion\` or \`/minions show <id|name>\` for full output, messages, path intent, and activity.
- Use \`send_minion_message\` to message a live orchestrated child without waiting. Not available to children. Parent-to-child mail does not start a parent turn.

Children are process-local. They die with the parent Pi process.
Live detach is not available.
User steering is not available.
`;

export function getMinionsSkill(): string {
  return MINIONS_SKILL;
}
