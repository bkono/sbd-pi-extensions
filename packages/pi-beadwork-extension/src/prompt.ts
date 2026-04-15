import type { ActivationState, BeadworkIssueDetail, SessionState } from "./types.js";

const PRIME_MAX_CHARS = 8_000;

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars).trimEnd()}\n\n[prime truncated]`;
}

function renderScopeSummary(scopeDetail: BeadworkIssueDetail | undefined): string[] {
  if (!scopeDetail) {
    return [];
  }

  const lines = [
    "## Scoped issue",
    `${scopeDetail.id} · ${scopeDetail.type} · ${scopeDetail.status} · P${scopeDetail.priority}`,
    scopeDetail.title,
  ];

  if (scopeDetail.parentId) {
    lines.push(`Parent: ${scopeDetail.parentId}`);
  }

  if (scopeDetail.blockedBy.length > 0) {
    lines.push(`Blocked by: ${scopeDetail.blockedBy.join(", ")}`);
  }

  if (scopeDetail.blocks.length > 0) {
    lines.push(`Blocks: ${scopeDetail.blocks.join(", ")}`);
  }

  if (scopeDetail.children.length > 0) {
    lines.push("Children:");
    for (const child of scopeDetail.children.slice(0, 12)) {
      lines.push(`- ${child.id} · ${child.status} · ${child.title}`);
    }
  }

  return lines;
}

export function buildBeadworkPromptAppendix(input: {
  activation: ActivationState;
  sessionState: SessionState;
  scopeDetail?: BeadworkIssueDetail;
}): string | undefined {
  const { activation, sessionState, scopeDetail } = input;
  if (activation.kind !== "active") {
    return undefined;
  }

  if (sessionState.mode === "neutral") {
    return undefined;
  }

  const modeGuidance =
    sessionState.mode === "interactive"
      ? [
          "You are in beadwork interactive mode.",
          "Stay human-led.",
          "Ask delivery-shape questions when needed.",
          "Encourage durable ticketization for non-trivial work.",
          "Prefer beadwork tickets over keeping long plans only in conversation.",
          "When converting a written plan into tickets, ask for an explicit plan source and then use beadwork tools.",
          "Do not infer dependency graphs from ad hoc chat formatting.",
          "Do not autonomously launch workers or act like a background orchestrator.",
        ]
      : [
          "You are in beadwork run mode.",
          "Prefer durable beadwork state over conversational replanning.",
          "Delegate against existing ready tickets when automation exists.",
          "Use beadwork tools for durable graph mutations instead of text parsing heuristics.",
          "Stop at explicit boundaries and summarize state clearly.",
        ];

  const scopeLine =
    sessionState.scope.kind === "none"
      ? "none"
      : `${sessionState.scope.kind}:${sessionState.scope.id}`;

  const sections = [
    "[BEADWORK SESSION ACTIVE]",
    ...modeGuidance,
    `Current scope: ${scopeLine}`,
    "Available beadwork tools: beadwork_status, beadwork_prime, beadwork_ready, beadwork_blocked, beadwork_list_issues, beadwork_issue_history, beadwork_show, beadwork_create_issue, beadwork_update_issue, beadwork_add_dependency, beadwork_remove_dependency, beadwork_start_issue, beadwork_close_issue, beadwork_reopen_issue, beadwork_comment_issue, beadwork_label_issue, beadwork_defer_issue, beadwork_undefer_issue, beadwork_sync, beadwork_delegate, beadwork_worker_check.",
    ...renderScopeSummary(scopeDetail),
  ];

  if (sessionState.prime?.content) {
    sections.push("## Cached bw prime", truncate(sessionState.prime.content, PRIME_MAX_CHARS));
  }

  return sections.join("\n\n");
}
