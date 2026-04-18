import type { BeadworkIssueDetail } from "./types.js";

const MAX_TEXT_CHARS = 4_000;

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n[truncated]`;
}

export function buildWorkerHandoff(input: {
  ticket: BeadworkIssueDetail;
  epic?: BeadworkIssueDetail;
  branchName: string;
  worktreePath: string;
  runtimeScratchDir?: string;
  prime?: string;
}): string {
  const lines = [
    "You are working one beadwork ticket in one worktree.",
    "",
    `Ticket: ${input.ticket.id} ${input.ticket.title}`,
  ];

  if (input.epic) {
    lines.push(`Epic: ${input.epic.id} ${input.epic.title}`);
  }

  lines.push(`Worktree: ${input.worktreePath}`);
  lines.push(`Branch: ${input.branchName}`);
  lines.push("", "Required first step:", `- Run \`bw start ${input.ticket.id}\``);
  lines.push(
    "",
    "Rules:",
    "- Stay scoped to this ticket.",
    "- Do not expand into unrelated cleanup unless required to land this ticket.",
    `- Land the work completely: commit your changes, run \`bw close ${input.ticket.id}\`, then \`bw sync\`.`,
    "- If you need scratch notes or generated context files, keep them out of git-tracked worktree paths.",
    "- If blocked, stop and report the blocker clearly.",
  );

  if (input.runtimeScratchDir) {
    lines.push(`- Use \`${input.runtimeScratchDir}\` for transient artifacts like context.md.`);
  }

  if (input.ticket.blockedBy.length > 0) {
    lines.push("", `Blocked by: ${input.ticket.blockedBy.join(", ")}`);
  }

  if (input.ticket.description.trim()) {
    lines.push("", "Ticket context:", truncate(input.ticket.description, MAX_TEXT_CHARS));
  }

  if (input.epic?.description.trim()) {
    lines.push("", "Epic context:", truncate(input.epic.description, MAX_TEXT_CHARS));
  }

  if (input.prime?.trim()) {
    lines.push("", "Cached bw prime guidance:", truncate(input.prime, MAX_TEXT_CHARS));
  }

  return lines.join("\n");
}
