import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  ActivationState,
  AdoptionPlan,
  BeadworkConfig,
  BeadworkCounts,
  BeadworkHistoryEntry,
  BeadworkIssue,
  BeadworkIssueDetail,
  SessionState,
} from "./types.js";

function describeActivation(activation: ActivationState): string {
  const repoRoot = activation.repoRoot ? ` (${activation.repoRoot})` : "";

  if (activation.kind === "active") {
    return `active${repoRoot}`;
  }

  const reason = activation.reason ? ` · ${activation.reason}` : "";
  return `${activation.kind}${reason}${repoRoot}`;
}

function describeScope(state: SessionState): string {
  if (state.scope.kind === "none") {
    return "none";
  }

  const title = state.scope.title ? ` · ${state.scope.title}` : "";
  return `${state.scope.kind}:${state.scope.id}${title}`;
}

function formatIssueLine(issue: BeadworkIssue): string {
  const bits = [`${issue.id}`, `${issue.status}`, `P${issue.priority}`, issue.title];

  if (issue.parentId) {
    bits.splice(1, 0, `parent:${issue.parentId}`);
  }

  return `- ${bits.join(" · ")}`;
}

export function formatStatusLines(input: {
  activation: ActivationState;
  state: SessionState;
  counts?: BeadworkCounts;
  scopeDetail?: BeadworkIssueDetail;
  config?: BeadworkConfig;
}): string[] {
  const { activation, state, counts, scopeDetail } = input;

  const lines = [
    `Activation: ${describeActivation(activation)}`,
    `Mode: ${state.mode}`,
    `Scope: ${describeScope(state)}`,
    `Updated: ${state.updatedAt}`,
  ];

  if (state.engagedAt) {
    lines.push(`Engaged: ${state.engagedAt}`);
  }

  if (state.prime?.loadedAt) {
    lines.push(`Prime cached: ${state.prime.loadedAt}`);
  }

  if (counts) {
    lines.push(
      `Counts: ready=${counts.ready} blocked=${counts.blocked} in_progress=${counts.inProgress}`,
    );
    if (counts.scopedReady !== undefined && state.scope.kind !== "none") {
      lines.push(`Scoped ready: ${counts.scopedReady}`);
    }
  }

  if (scopeDetail) {
    lines.push(
      `Scoped issue: ${scopeDetail.id} · ${scopeDetail.type} · ${scopeDetail.status} · ${scopeDetail.title}`,
    );
    if (scopeDetail.blockedBy.length > 0) {
      lines.push(`Blocked by: ${scopeDetail.blockedBy.join(", ")}`);
    }
    if (scopeDetail.children.length > 0) {
      lines.push(`Children: ${scopeDetail.children.length}`);
    }
  }

  if (activation.detail) {
    lines.push(`Detail: ${activation.detail}`);
  }

  return lines;
}

export async function showStatus(
  ctx: ExtensionCommandContext,
  input: {
    activation: ActivationState;
    state: SessionState;
    counts?: BeadworkCounts;
    scopeDetail?: BeadworkIssueDetail;
    config?: BeadworkConfig;
  },
): Promise<void> {
  ctx.ui.notify(formatStatusLines(input).join("\n"), "info");
}

export async function showPrime(
  ctx: ExtensionCommandContext,
  prime: string,
  loadedAt?: string,
): Promise<void> {
  const prefix = loadedAt ? `bw prime (${loadedAt})\n\n` : "bw prime\n\n";
  ctx.ui.notify(`${prefix}${prime}`, "info");
}

export async function showReady(
  ctx: ExtensionCommandContext,
  ready: BeadworkIssue[],
  scopeId?: string,
): Promise<void> {
  if (ready.length === 0) {
    ctx.ui.notify(scopeId ? `No ready work for scope ${scopeId}.` : "No ready work.", "info");
    return;
  }

  const lines = [scopeId ? `Ready work for ${scopeId}:` : "Ready work:"];
  for (const issue of ready.slice(0, 20)) {
    lines.push(formatIssueLine(issue));
  }
  if (ready.length > 20) {
    lines.push(`… ${ready.length - 20} more`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showIssueList(
  ctx: ExtensionCommandContext,
  issues: BeadworkIssue[],
  heading: string,
): Promise<void> {
  if (issues.length === 0) {
    ctx.ui.notify(`${heading}\n- none`, "info");
    return;
  }

  const lines = [heading];
  for (const issue of issues.slice(0, 20)) {
    lines.push(formatIssueLine(issue));
  }
  if (issues.length > 20) {
    lines.push(`… ${issues.length - 20} more`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showHistory(
  ctx: ExtensionCommandContext,
  issueId: string,
  entries: BeadworkHistoryEntry[],
): Promise<void> {
  if (entries.length === 0) {
    ctx.ui.notify(`History for ${issueId}:\n- no entries`, "info");
    return;
  }

  const lines = [`History for ${issueId}:`];
  for (const entry of entries) {
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "unknown time";
    const author = typeof entry.author === "string" ? entry.author : "unknown";
    const intent =
      typeof entry.intent === "string" ? entry.intent : (JSON.stringify(entry) ?? "[entry]");
    lines.push(`- ${timestamp} · ${author} · ${intent}`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showIssue(
  ctx: ExtensionCommandContext,
  issue: BeadworkIssueDetail,
): Promise<void> {
  const lines = [`${issue.id} · ${issue.type} · ${issue.status} · P${issue.priority}`, issue.title];

  if (issue.parentId) {
    lines.push(`Parent: ${issue.parentId}`);
  }
  if (issue.assignee) {
    lines.push(`Assignee: ${issue.assignee}`);
  }
  if (issue.blockedBy.length > 0) {
    lines.push(`Blocked by: ${issue.blockedBy.join(", ")}`);
  }
  if (issue.blocks.length > 0) {
    lines.push(`Blocks: ${issue.blocks.join(", ")}`);
  }
  if (issue.description.trim()) {
    lines.push("", issue.description.trim());
  }
  if (issue.children.length > 0) {
    lines.push("", "Children:");
    for (const child of issue.children) {
      lines.push(formatIssueLine(child));
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showMutationResult(
  ctx: ExtensionCommandContext,
  label: string,
  issue: BeadworkIssue,
): Promise<void> {
  ctx.ui.notify(`${label}: ${issue.id} · ${issue.status} · ${issue.title}`, "info");
}

export async function showAdoptionPreview(
  ctx: ExtensionCommandContext,
  plan: AdoptionPlan,
  preview: string,
): Promise<void> {
  const hint =
    plan.landMode === "quick"
      ? "Run again with --land quick --apply to confirm the quick-fix posture."
      : plan.landMode === "multi"
        ? "Run again with --land multi --apply to launch an LLM-guided decomposition turn that materializes the graph with beadwork tools."
        : "Run again with --apply to create beadwork artifacts.";
  ctx.ui.notify(`${preview}\n\n${hint}`, "info");
}

export async function showAdoptionResult(
  ctx: ExtensionCommandContext,
  lines: string[],
): Promise<void> {
  ctx.ui.notify(lines.join("\n"), "info");
}
