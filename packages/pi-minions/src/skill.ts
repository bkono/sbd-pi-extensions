export const MINIONS_SKILL = `# pi-minions

Use minions when independent work can run in isolated foreground agent sessions and you need the result before continuing.

Available surfaces:
- Use the \`spawn\` tool for a single foreground minion. Provide \`task\`, optional \`agent\`, and optional \`model\`.
- Use \`spawn\` with a \`tasks\` array to run multiple foreground minions in parallel. Each item accepts \`task\`, optional \`agent\`, and optional \`model\`.
- Use \`list_agents\` before selecting named agents when you are unsure what is available.
- Use \`halt\` with a minion id, name, group id, \`group\`, or \`all\` to abort running minions. Halt of a group forgets the open orchestration group so the next orchestrate creates a new id. Halt does not exit Beadwork goal mode.
- Use \`list_minions\` to see spawn vs orchestrated minions, including role, taskType, group, last said, and peer-message failures.
- Use \`show_minion\` or \`/minions show <id|name>\` for full output, messages, path intent, and activity.

Background minions are not available.
Live detach is not available.
User steering is not available.
`;

export function getMinionsSkill(): string {
  return MINIONS_SKILL;
}
