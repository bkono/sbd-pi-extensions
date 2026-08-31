import { isInterruptedRun } from "./session-state.js";
import type { ActivationState, BeadworkIssueDetail, ReviewPolicy, SessionState } from "./types.js";

const PRIME_MAX_CHARS = 8_000;

export const GOAL_TASK_TYPES = [
  "implementation",
  "fix",
  "reviewImplementation",
  "reviewScope",
  "investigateBlocker",
] as const;

export type GoalTaskType = (typeof GOAL_TASK_TYPES)[number];

export const REVIEW_POLICIES = ["ticket", "scope", "none"] as const;

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = "ticket";

/** Locked scope-policy copy. Goldens fail if this tradeoff sentence is dropped. */
export const SCOPE_POLICY_TRADEOFF =
  "Dependents may start before aggregate review finds a problem.";

const BEADWORK_PARENT_TOOLS = [
  "beadwork_status",
  "beadwork_prime",
  "beadwork_ready",
  "beadwork_blocked",
  "beadwork_list_issues",
  "beadwork_issue_history",
  "beadwork_show",
  "beadwork_create_issue",
  "beadwork_update_issue",
  "beadwork_add_dependency",
  "beadwork_remove_dependency",
  "beadwork_start_issue",
  "beadwork_close_issue",
  "beadwork_reopen_issue",
  "beadwork_comment_issue",
  "beadwork_label_issue",
  "beadwork_defer_issue",
  "beadwork_undefer_issue",
  "beadwork_sync",
  "beadwork_start_goal",
] as const;

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

export function selectReviewPolicy(sessionState: SessionState): ReviewPolicy {
  return sessionState.goal?.reviewPolicy ?? DEFAULT_REVIEW_POLICY;
}

function renderModeGuidance(mode: "interactive" | "run"): string[] {
  if (mode === "interactive") {
    return [
      "You are in beadwork interactive mode.",
      "Stay human-led.",
      "Ask delivery-shape questions when needed.",
      "Encourage durable ticketization for non-trivial work.",
      "Prefer beadwork tickets over keeping long plans only in conversation.",
      "When converting a written plan into tickets, ask for an explicit plan source and then use beadwork tools.",
      "Do not infer dependency graphs from ad hoc chat formatting.",
      "Do not autonomously launch children or act like a background orchestrator.",
      "Do not auto-start goal mode merely because an epic exists, becomes ready, or was just created.",
      "This standing appendix is policy only. It does not start a turn. Wait for the user.",
    ];
  }

  return [
    "You are in beadwork run mode.",
    "Goal mode: run the scoped epic to completion.",
    "This is a manager-only loop.",
    "Prefer durable beadwork state over conversational replanning.",
    "Use `orchestrate` plus beadwork tools. Do not poll.",
    "The parent owns ready/show, ticket start/close, task composition, dispatch, SHA handoff, independent review, adjudication/fixes, and keeping ready work in flight.",
    "The parent does not implement a delegated ticket concurrently with its live child.",
    "Children do not start, close, or reopen tickets, and do not start goals.",
    "Child settlement is evidence, not acceptance or ticket closure. Do not close a ticket solely because a child settled.",
    "Use beadwork tools for durable graph mutations instead of text parsing heuristics.",
    "When a turn runs: refresh `bw` (ready/show), start ready work, compose each child's `task`, then `orchestrate`.",
    "This standing appendix is policy only. It does not start a turn.",
  ];
}

function renderInterruptedRunGuidance(): string[] {
  return [
    "Beadwork run was interrupted.",
    "Do not orchestrate.",
    "Wait for the user.",
    "Resume only after explicit `/bw run <epic-id>` or `beadwork_start_goal`.",
  ];
}

function renderAgentVsTaskType(): string {
  return [
    "## Agent vs task type",
    "",
    "Agent (discovered name): how the child works (prompt/template). Same field on spawn and orchestrate. Call `list_agents` if unsure. Built-in `worker` and `investigate` are always available.",
    "Task type (closed): what question the parent asks when that child settles, fails, aborts, or asks.",
    "Optional on untyped work. Never collapse agent and task type into one field.",
  ].join("\n");
}

function renderTaskTypePolicy(): string {
  return [
    "## Task types on orchestrate",
    "",
    "Pass `taskType` when you need a known next question after the child settles, fails, aborts, or asks.",
    "Omit `taskType` for untyped research or exploration.",
    "",
    "- `implementation` — new ticket work. On settle: assess evidence, apply the active review policy, and do not close solely because the child settled.",
    "- `fix` — remediation of a required finding. On settle: re-review before accept.",
    "- `reviewImplementation` — independent ticket review. On settle: disposition every finding as fix | file | reject (fix is blocking; file is nonblocking unless the user waives a blocker; reject records why). No keyword classifier.",
    "- `reviewScope` — aggregate review before epic complete (scope policy).",
    "- `investigateBlocker` — investigation of blocked work. Settlement is not implementation completion.",
  ].join("\n");
}

function renderReviewPolicy(policy: ReviewPolicy): string {
  const catalog = "Review policies: `ticket` (default), `scope`, and `none`.";
  const branchLine = `Review policy branch: ${policy}`;

  if (policy === "ticket") {
    return [
      "## Review policy",
      "",
      catalog,
      branchLine,
      "Active review policy: ticket (default).",
      "Launch an independent `reviewImplementation` child before closing that ticket.",
      "Do not close from implementer settlement alone.",
    ].join("\n");
  }

  if (policy === "scope") {
    return [
      "## Review policy",
      "",
      catalog,
      branchLine,
      "Active review policy: scope.",
      "You may close individual tickets from evidence without an independent per-ticket review child.",
      "Launch a `reviewScope` child before declaring the epic complete.",
      SCOPE_POLICY_TRADEOFF,
    ].join("\n");
  }

  return [
    "## Review policy",
    "",
    catalog,
    branchLine,
    "Active review policy: none.",
    "Skip independent review children.",
    "Still judge from Git and `bw` before close. Child settlement is not acceptance.",
  ].join("\n");
}

function renderChildTaskComposition(): string {
  return [
    "## Child task composition",
    "",
    "Start-before-work: call `beadwork_start_issue` (or `bw start`) on the ticket before the child begins work.",
    "Compose `task` yourself: the `orchestrate` `task` field is the complete child prompt. Beadwork does not wrap it.",
    'Attach domain metadata: source "beadwork", scopeId (epic id), workItemId (ticket id), title.',
    "Tell implementation children to make one atomic ticket-scoped commit, return the commit SHA, stage only owned files, and not close tickets. The parent closes after it judges evidence.",
    "Reviewer children start only after the implementer settles. They inspect named commits, the named SHA, the ticket id, and `git show`. Do not tell them to read the whole dirty workspace.",
    "Do not start review of ticket A while A's implementer is still live. That is an instruction, not a lock.",
  ].join("\n");
}

function renderGoalStartGuidance(): string {
  return [
    "## Goal mode entry",
    "",
    "Human `/bw run <epic-id>` and model `beadwork_start_goal({ epic_id })` are equivalent entry surfaces for the same lifecycle.",
    "Call `beadwork_start_goal({ epic_id })` only after you have intentionally chosen to execute a ready, already-decomposed open epic.",
    "Do not imitate `/bw run` with `ready`, ticket mutations, and `orchestrate`.",
    "Starting a goal is an explicit manager-intent transition. It arms persistent policy and queues continuation. It does not implement the epic or dispatch children.",
    "Do not infer an epic. Do not auto-start because an epic exists, becomes ready, or was just created. Do not treat this as a synchronous run wrapper.",
    "Planning/decomposition and executing the graph are distinct decisions.",
  ].join("\n");
}

function renderQualityCommands(): string {
  return [
    "## Quality commands",
    "",
    "Project quality commands (`lint` / `test` / `typecheck`, or whatever the repo uses) are implementer, reviewer, and repo-checkpoint work.",
    "Beadwork does not own a validation gate.",
  ].join("\n");
}

function renderDoNot(): string {
  return [
    "## Do not",
    "",
    "Do not use tmux, landing, `--workers`, or polling.",
    "Do not classify review findings with a keyword matcher.",
    "Do not auto-start goal mode merely because an epic exists, becomes ready, or was just created.",
  ].join("\n");
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

  const scopeLine =
    sessionState.scope.kind === "none"
      ? "none"
      : `${sessionState.scope.kind}:${sessionState.scope.id}`;

  if (isInterruptedRun(sessionState)) {
    return [
      "[BEADWORK SESSION ACTIVE]",
      renderInterruptedRunGuidance().join("\n"),
      `Current scope: ${scopeLine}`,
      ...renderScopeSummary(scopeDetail),
    ].join("\n\n");
  }

  const reviewPolicy = selectReviewPolicy(sessionState);

  const sections = [
    "[BEADWORK SESSION ACTIVE]",
    renderModeGuidance(sessionState.mode).join("\n"),
    renderGoalStartGuidance(),
    `Current scope: ${scopeLine}`,
    renderAgentVsTaskType(),
    renderTaskTypePolicy(),
    renderReviewPolicy(reviewPolicy),
    renderChildTaskComposition(),
    renderQualityCommands(),
    renderDoNot(),
    `Available beadwork tools: ${BEADWORK_PARENT_TOOLS.join(", ")}.`,
    ...renderScopeSummary(scopeDetail),
  ];

  if (sessionState.prime?.content) {
    sections.push("## Cached bw prime", truncate(sessionState.prime.content, PRIME_MAX_CHARS));
  }

  return sections.join("\n\n");
}
