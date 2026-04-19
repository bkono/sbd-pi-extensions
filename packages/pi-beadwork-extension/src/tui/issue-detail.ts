import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { BeadworkIssue, BeadworkIssueDetail } from "../types.js";
import {
  kv,
  priorityBadge,
  sectionTitle,
  selectionMarker,
  statusStyle,
  styledDim,
  styledLabel,
  typeBadge,
} from "./common.js";

function formatList(values: string[] | undefined, empty = "none"): string {
  return values && values.length > 0 ? values.join(", ") : empty;
}
function formatAssignee(issue: BeadworkIssue): string {
  return issue.assignee.trim() ? issue.assignee : "unassigned";
}

function formatDescription(theme: Theme, issue: BeadworkIssueDetail): string {
  const description = issue.description.trim();
  if (!description) {
    return styledDim(theme, "(no description)");
  }
  const firstParagraph = description.split(/\n\s*\n/u)[0] ?? description;
  return styledDim(theme, firstParagraph.replace(/\s+/gu, " ").trim());
}
function clamp(text: string, width: number): string {
  return truncateToWidth(text, Math.max(12, width), "…");
}

export function formatIssueSummary(theme: Theme, issue: BeadworkIssue, width = 72): string {
  return clamp(
    `${styledLabel(theme, issue.id)} · ${typeBadge(theme, issue.type)} · ${statusStyle(theme, issue.status)} · ${priorityBadge(theme, issue.priority)} · ${issue.title}`,
    width,
  );
}
export function renderIssueListEntry(
  theme: Theme,
  issue: BeadworkIssue,
  input: { selected: boolean; width: number },
): string[] {
  const marker = selectionMarker(theme, input.selected);
  const titleWidth = Math.max(18, input.width - 4);
  return [
    `${marker} ${styledLabel(theme, issue.id)} · ${typeBadge(theme, issue.type)} · ${statusStyle(theme, issue.status)} · ${priorityBadge(theme, issue.priority)}`,
    `  ${clamp(issue.title, titleWidth)}`,
  ];
}
export function renderIssueDetail(input: {
  theme: Theme;
  issue?: BeadworkIssueDetail;
  heading: string;
  emptyMessage?: string;
  width?: number;
}): string[] {
  const { theme, issue, heading, emptyMessage = "No issue selected.", width = 48 } = input;
  if (!issue) {
    return [sectionTitle(theme, heading), styledDim(theme, emptyMessage)];
  }
  const lines = [
    sectionTitle(theme, heading),
    `${styledLabel(theme, issue.id)} · ${typeBadge(theme, issue.type)} · ${statusStyle(theme, issue.status)} · ${priorityBadge(theme, issue.priority)}`,
    clamp(issue.title, width),
    `${kv(theme, "Owner", formatAssignee(issue))} · ${kv(theme, "parent", issue.parentId ?? "none")}`,
    `${kv(theme, "Children", String(issue.children.length))} · ${kv(theme, "labels", formatList(issue.labels))}`,
    `${kv(theme, "Deps", `↓ ${issue.blockedBy.length || 0} · ↑ ${issue.blocks.length || 0}`)}`,
    "",
    sectionTitle(theme, "Summary"),
    formatDescription(theme, issue),
  ];
  if (issue.children.length > 0) {
    lines.push(
      "",
      sectionTitle(theme, "Children"),
      ...issue.children
        .slice(0, 3)
        .map(
          (child) =>
            `${styledDim(theme, "•")} ${styledLabel(theme, child.id)} · ${statusStyle(theme, child.status)} · ${clamp(child.title, Math.max(16, width - 6))}`,
        ),
    );
  }
  return lines;
}
