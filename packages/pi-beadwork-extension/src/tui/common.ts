import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SurfaceTone =
  | "normal"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "selected";

export type SurfaceSection = {
  title?: string;
  lines: string[];
  tone?: SurfaceTone;
};

export type SurfaceRenderInput = {
  title: string;
  subtitle?: string[];
  sections?: SurfaceSection[];
  footer?: string;
  bodyHeight?: number;
};

// ─── Theme-Aware Content Helpers ─────────────────────────────────────────────

/** Muted/dim label text (e.g., field names, secondary info) */
export function styledLabel(theme: Theme, text: string): string {
  return theme.fg("muted", text);
}

/** Normal/bright value text */
export function styledValue(theme: Theme, text: string): string {
  return theme.fg("text", text);
}

/** Accent-colored text (selected items, active states) */
export function styledAccent(theme: Theme, text: string): string {
  return theme.fg("accent", text);
}

/** Green — completed, landed, passed */
export function styledSuccess(theme: Theme, text: string): string {
  return theme.fg("success", text);
}

/** Yellow — held, attention, deferred */
export function styledWarning(theme: Theme, text: string): string {
  return theme.fg("warning", text);
}

/** Red — failed, error, blocked */
export function styledError(theme: Theme, text: string): string {
  return theme.fg("error", text);
}

/** Dim text — disabled, empty, tertiary info */
export function styledDim(theme: Theme, text: string): string {
  return theme.fg("dim", text);
}

/** Bold + bright section heading */
export function sectionTitle(theme: Theme, text: string): string {
  return theme.bold(theme.fg("text", text));
}

/** key: value — muted key, normal value */
export function kv(theme: Theme, key: string, value: string): string {
  return `${theme.fg("muted", `${key}:`)} ${value}`;
}

/** Selection marker: ▸ when selected, space when not */
export function selectionMarker(theme: Theme, selected: boolean): string {
  return selected ? theme.fg("accent", "▸") : " ";
}

/** Colored count badge: e.g. "3 ready" in success color */
export function countBadge(
  theme: Theme,
  n: number,
  label: string,
  tone: SurfaceTone = "normal",
): string {
  const text = `${n} ${label}`;
  return styleTone(theme, text, tone);
}

/** Map issue status to appropriate styled string */
export function statusStyle(theme: Theme, status: string): string {
  switch (status) {
    case "open":
      return theme.fg("accent", status);
    case "in-progress":
      return theme.fg("accent", status);
    case "closed":
    case "done":
    case "landed":
      return theme.fg("success", status);
    case "blocked":
      return theme.fg("error", status);
    case "deferred":
      return theme.fg("warning", status);
    default:
      return theme.fg("muted", status);
  }
}

/** Map worker status to appropriate styled string */
export function workerStatusStyle(theme: Theme, status: string): string {
  switch (status) {
    case "running":
    case "launching":
      return theme.fg("accent", status);
    case "held":
    case "attention":
      return theme.fg("warning", status);
    case "failed":
      return theme.fg("error", status);
    case "landed":
    case "exited":
      return theme.fg("success", status);
    default:
      return theme.fg("muted", status);
  }
}

/** Priority badge with urgency-based coloring: P0 (error) → P4 (dim) */
export function priorityBadge(theme: Theme, priority: number): string {
  const label = `P${priority}`;
  switch (priority) {
    case 0:
      return theme.fg("error", label);
    case 1:
      return theme.fg("warning", label);
    case 2:
      return theme.fg("accent", label);
    case 3:
      return theme.fg("muted", label);
    default:
      return theme.fg("dim", label);
  }
}

/** Type badge with distinct styling */
export function typeBadge(theme: Theme, type: string): string {
  switch (type) {
    case "epic":
      return theme.fg("accent", type);
    case "task":
      return theme.fg("muted", type);
    default:
      return theme.fg("dim", type);
  }
}

// ─── ANSI-Safe Layout Utilities ──────────────────────────────────────────────

function styleTone(theme: Theme, text: string, tone: SurfaceTone = "normal"): string {
  switch (tone) {
    case "muted":
      return theme.fg("muted", text);
    case "accent":
      return theme.fg("accent", text);
    case "success":
      return theme.fg("success", text);
    case "warning":
      return theme.fg("warning", text);
    case "error":
      return theme.fg("error", text);
    case "selected":
      return theme.bg("selectedBg", theme.fg("accent", text));
    default:
      return text;
  }
}

export function padAnsi(text: string, width: number): string {
  const truncated = truncateToWidth(text, Math.max(0, width), "");
  const padding = Math.max(0, width - visibleWidth(truncated));
  return truncated + " ".repeat(padding);
}

export function wrapAnsiToWidth(text: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }

  return wrapTextWithAnsi(text, width).map((line) => padAnsi(line, width));
}

export function normalizeSurfaceLines(lines: string[], width: number, height?: number): string[] {
  const normalized = lines.flatMap((line) => wrapAnsiToWidth(line, width));
  if (height === undefined) {
    return normalized;
  }

  if (normalized.length > height) {
    const hidden = normalized.length - height + 1;
    return [
      ...normalized.slice(0, Math.max(0, height - 1)),
      padAnsi(`… ${hidden} more line${hidden === 1 ? "" : "s"}`, width),
    ];
  }

  return [
    ...normalized,
    ...Array.from({ length: height - normalized.length }, () => " ".repeat(width)),
  ];
}

export function joinColumns(input: {
  left: string[];
  right: string[];
  leftWidth: number;
  rightWidth: number;
  gap?: number;
}): string[] {
  const gap = " ".repeat(input.gap ?? 2);
  const leftLines = input.left.flatMap((line) => wrapAnsiToWidth(line, input.leftWidth));
  const rightLines = input.right.flatMap((line) => wrapAnsiToWidth(line, input.rightWidth));
  const total = Math.max(leftLines.length, rightLines.length);
  const rows: string[] = [];

  for (let index = 0; index < total; index += 1) {
    rows.push(
      `${padAnsi(leftLines[index] ?? "", input.leftWidth)}${gap}${padAnsi(rightLines[index] ?? "", input.rightWidth)}`,
    );
  }

  return rows;
}

// ─── Surface Renderer (Rounded Borders, Embedded Title/Footer) ───────────────

export function renderSurface(theme: Theme, width: number, input: SurfaceRenderInput): string[] {
  const innerWidth = Math.max(24, width - 4);
  const border = (text: string, accent = false) =>
    theme.fg(accent ? "borderAccent" : "borderMuted", text);
  const background = (text: string) => theme.bg("customMessageBg", padAnsi(text, innerWidth));
  const separator = border(`├${"─".repeat(innerWidth + 2)}┤`);

  const bodyLines = normalizeSurfaceLines(
    [
      ...(input.subtitle ?? []),
      ...((input.subtitle?.length ?? 0) > 0 && (input.sections?.length ?? 0) > 0 ? [""] : []),
      ...(input.sections ?? []).flatMap((section, index) => {
        const lines: string[] = [];
        if (index > 0) {
          lines.push("");
        }
        if (section.title) {
          lines.push(styleTone(theme, section.title, section.tone ?? "accent"));
        }
        lines.push(...section.lines.map((line) => styleTone(theme, line, section.tone)));
        return lines;
      }),
    ],
    innerWidth,
    input.bodyHeight,
  );

  // ─ Top border with embedded title ─
  const titleText = ` ${theme.fg("accent", theme.bold(input.title))} `;
  const titleVisibleLen = visibleWidth(titleText);
  const topRuleLen = Math.max(0, innerWidth + 2 - titleVisibleLen - 1);
  const topBorder = `${border("╭─", true)}${titleText}${border(`${"─".repeat(topRuleLen)}╮`, true)}`;

  const lines = [topBorder];

  if (bodyLines.length > 0) {
    lines.push(separator);
    for (const line of bodyLines) {
      lines.push(`${border("│")} ${background(line)} ${border("│")}`);
    }
  }

  // ─ Bottom border with embedded footer ─
  if (input.footer) {
    lines.push(separator);
    const footerText = ` ${theme.fg("dim", input.footer)} `;
    const footerVisibleLen = visibleWidth(footerText);
    const bottomRuleLen = Math.max(0, innerWidth + 2 - footerVisibleLen - 1);
    lines.push(
      `${border("╰─", true)}${footerText}${border(`${"─".repeat(bottomRuleLen)}╯`, true)}`,
    );
  } else {
    lines.push(border(`╰${"─".repeat(innerWidth + 2)}╯`, true));
  }

  return lines;
}

// ─── Tab Line ────────────────────────────────────────────────────────────────

export function renderTabLine(
  theme: Theme,
  tabs: Array<{ label: string; selected: boolean }>,
  width: number,
): string {
  const pieces = tabs.map((tab) => {
    const label = ` ${tab.selected ? "●" : "○"} ${tab.label} `;
    return tab.selected ? theme.bg("selectedBg", theme.fg("accent", label)) : label;
  });
  return padAnsi(pieces.join(" "), width);
}
