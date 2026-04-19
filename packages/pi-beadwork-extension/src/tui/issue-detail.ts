import type { BeadworkIssue, BeadworkIssueDetail } from "../types.js";

function formatList(values: string[] | undefined, empty = "none"): string {
  return values && values.length > 0 ? values.join(", ") : empty;
}

function formatAssignee(issue: BeadworkIssue): string {
  return issue.assignee.trim() ? issue.assignee : "unassigned";
}

export function formatIssueSummary(issue: BeadworkIssue): string {
  return `${issue.id} · ${issue.type} · ${issue.status} · P${issue.priority} · ${issue.title}`;
}

export function renderIssueDetail(input: {
  issue?: BeadworkIssueDetail;
  heading: string;
  emptyMessage?: string;
}): string[] {
  const { issue, heading, emptyMessage = "No issue selected." } = input;
  if (!issue) {
    return [heading, emptyMessage];
  }

  const lines = [
    heading,
    `${issue.id} · ${issue.type} · ${issue.status} · P${issue.priority}`,
    `Title: ${issue.title}`,
    `Parent: ${issue.parentId ?? "none"}`,
    `Assignee: ${formatAssignee(issue)}`,
    `Labels: ${formatList(issue.labels)}`,
    `Blocked by: ${formatList(issue.blockedBy)}`,
    `Blocks: ${formatList(issue.blocks)}`,
    `Children: ${issue.children.length}`,
    "Description:",
    issue.description.trim() ? issue.description.trim() : "(no description)",
  ];

  if (issue.children.length > 0) {
    lines.push("", "Children:");
    for (const child of issue.children.slice(0, 5)) {
      lines.push(`- ${formatIssueSummary(child)}`);
    }
    if (issue.children.length > 5) {
      lines.push(`- … ${issue.children.length - 5} more child issues`);
    }
  }

  return lines;
}
