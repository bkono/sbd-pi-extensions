import { truncateToWidth } from "@mariozechner/pi-tui";
import type { BeadworkIssue, BeadworkIssueDetail } from "../types.js";

function formatList(values: string[] | undefined, empty = "none"): string {
  return values && values.length > 0 ? values.join(", ") : empty;
}

function formatAssignee(issue: BeadworkIssue): string {
  return issue.assignee.trim() ? issue.assignee : "unassigned";
}

function formatDescription(issue: BeadworkIssueDetail): string {
  const description = issue.description.trim();
  if (!description) {
    return "(no description)";
  }

  const firstParagraph = description.split(/\n\s*\n/u)[0] ?? description;
  return firstParagraph.replace(/\s+/gu, " ").trim();
}

function clamp(text: string, width: number): string {
  return truncateToWidth(text, Math.max(12, width), "…");
}

export function formatIssueSummary(issue: BeadworkIssue, width = 72): string {
  return clamp(
    `${issue.id} · ${issue.type} · ${issue.status} · P${issue.priority} · ${issue.title}`,
    width,
  );
}

export function renderIssueListEntry(
  issue: BeadworkIssue,
  input: { selected: boolean; width: number },
): string[] {
  const marker = input.selected ? "❯" : " ";
  const titleWidth = Math.max(18, input.width - 4);
  return [
    `${marker} ${issue.id} · ${issue.type} · ${issue.status} · P${issue.priority}`,
    `  ${clamp(issue.title, titleWidth)}`,
  ];
}

export function renderIssueDetail(input: {
  issue?: BeadworkIssueDetail;
  heading: string;
  emptyMessage?: string;
  width?: number;
}): string[] {
  const { issue, heading, emptyMessage = "No issue selected.", width = 48 } = input;
  if (!issue) {
    return [heading, emptyMessage];
  }

  const lines = [
    heading,
    `${issue.id} · ${issue.type} · ${issue.status} · P${issue.priority}`,
    clamp(issue.title, width),
    `Owner ${formatAssignee(issue)} · parent ${issue.parentId ?? "none"}`,
    `Children ${issue.children.length} · labels ${formatList(issue.labels)}`,
    `Deps ↓ ${issue.blockedBy.length || 0} · ↑ ${issue.blocks.length || 0}`,
    "",
    "Summary",
    formatDescription(issue),
  ];

  if (issue.children.length > 0) {
    lines.push(
      "",
      "Children",
      ...issue.children
        .slice(0, 3)
        .map(
          (child) =>
            `• ${child.id} · ${child.status} · ${clamp(child.title, Math.max(16, width - 6))}`,
        ),
    );
  }

  return lines;
}
