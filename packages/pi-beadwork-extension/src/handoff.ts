import type { BeadworkIssueDetail } from "./types.js";

const MAX_TEXT_CHARS = 4_000;

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n[truncated]`;
}

type SharedHandoffContext = {
  ticket: BeadworkIssueDetail;
  epic?: BeadworkIssueDetail;
  prime?: string;
};

function appendSharedHandoffContext(lines: string[], input: SharedHandoffContext): void {
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
}

export function buildWorkerSelfReviewPrompt(input: { ticketId: string }): string {
  return [
    "Before the coordinator accepts this worker as done, do one focused self-review pass in this same session.",
    "You keep your first-pass context; use it, but verify the final result with fresh eyes.",
    "",
    "Self-review checklist:",
    "- Re-read the ticket goal and compare it to the committed changes.",
    "- Inspect the final diff/commits for bugs, missed files, accidental broad changes, stale docs, and weak tests.",
    "- Run the relevant validation you can reasonably run from this checkout.",
    "- Fix anything you find with focused commits that still reference the ticket.",
    "- Leave or update the handoff comment with commits and validation results.",
    "",
    `After that pass is complete, call \`beadwork_worker_done\` again for ticket ${input.ticketId} with \`self_review_completed: true\`.`,
    "Do not exit before making that second completion call.",
  ].join("\n");
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
    `- Land the work completely: commit your changes, leave a concise \`bw comment ${input.ticket.id}\` handoff, then call \`beadwork_worker_done\` for ticket ${input.ticket.id}.`,
    "- If you need scratch notes or generated context files, keep them out of git-tracked worktree paths.",
    "- If blocked, stop and report the blocker clearly.",
  );

  if (input.runtimeScratchDir) {
    lines.push(`- Use \`${input.runtimeScratchDir}\` for transient artifacts like context.md.`);
  }

  appendSharedHandoffContext(lines, input);

  return lines.join("\n");
}

export function buildCurrentBranchHandoffPrompt(input: {
  ticket: BeadworkIssueDetail;
  epic?: BeadworkIssueDetail;
  checkoutPath: string;
  branchName: string;
  runtimeScratchDir?: string;
  prime?: string;
}): string {
  const lines = [
    "You are a beadwork worker operating in shared current-branch mode.",
    `You are working ticket \`${input.ticket.id}\` in the current checkout/current branch.`,
    "",
    `Ticket: ${input.ticket.id} ${input.ticket.title}`,
  ];

  if (input.epic) {
    lines.push(`Epic: ${input.epic.id} ${input.epic.title}`);
  }

  lines.push(`Current checkout: ${input.checkoutPath}`);
  lines.push(`Current branch: ${input.branchName}`);
  lines.push(
    "",
    "Required first step:",
    `- Run \`bw start ${input.ticket.id}\` before beginning work unless the ticket is already started.`,
  );
  lines.push(
    "",
    "Rules:",
    "- Do not create a branch, PR, or alternate checkout unless explicitly instructed.",
    "- Keep the change scoped to this ticket; do not expand into unrelated cleanup.",
    "- Coordinate via `bw comment`, child tickets, dependencies, and labels when scope or ordering needs clarification.",
    `- Make atomic commits that clearly reference ticket ${input.ticket.id}.`,
    `- Stage and commit only the specific files intentionally changed for this ticket: \`git commit <specific-files> -m "<message referencing ${input.ticket.id}>"\` (the safe \`git commit <files> -m\` pattern).`,
    "- Avoid broad staging commands such as `git add -A`, `git add .`, and `git commit -a` unless truly every affected path is ticket-scoped and you have inspected the resulting diff.",
    "- Do not stash, reset, clean, discard, or otherwise manipulate unrelated checkout state; it may belong to another active worker.",
    "- Inspect `git diff -- <specific-files>` and `git status --short` before committing so each commit contains only ticket-scoped work.",
    `- Before exiting, leave a concise, natural handoff comment with \`bw comment ${input.ticket.id}\` that names status, commit SHAs when known, validation run/results, blockers, and useful follow-up recommendations.`,
    `- When done, call \`beadwork_worker_done\` for ticket ${input.ticket.id}; it will close/sync and either request one same-session self-review pass or shut this worker down.`,
    `- If blocked, explain the blocker in a \`bw comment ${input.ticket.id}\`, leave the ticket open, and exit so the coordinator can respond.`,
  );

  if (input.runtimeScratchDir) {
    lines.push(
      `- Use \`${input.runtimeScratchDir}\` for scratch/runtime artifacts and transient context files that should not be committed.`,
    );
  }

  appendSharedHandoffContext(lines, input);

  return lines.join("\n");
}
