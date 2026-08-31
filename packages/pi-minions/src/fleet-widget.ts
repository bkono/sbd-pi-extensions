import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { projectTrustedActivity, sanitizeActivityText } from "./activity.js";
import type { OrchestrationGroupState } from "./orchestration/group-state.js";
import type { AgentTree } from "./tree.js";
import { type AgentNode, namedAgent } from "./types.js";

export const FLEET_WIDGET_KEY = "minions-fleet";
export const FLEET_WIDGET_ROW_CAP = 5;

const IDENTITY_TEXT_MAX = 80;
const COLUMN_GAP = "  ";
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

function clean(text: string | undefined, max = IDENTITY_TEXT_MAX): string {
  return text ? sanitizeActivityText(text, max) : "";
}

function bounded(line: string, width: number): string {
  if (width <= 0) return "";
  return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

function firstGraphemeWidth(text: string): number {
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    return Math.max(1, visibleWidth(segment));
  }
  return 0;
}

function activityLabel(node: AgentNode): string {
  const summary = node.activity
    ? projectTrustedActivity(node.activity).summary
    : node.status === "pending"
      ? "starting"
      : "thinking";
  return node.status === "pending" ? `pending · ${summary}` : summary;
}

function metadataLabel(node: AgentNode): string {
  return [clean(namedAgent(node), 32), clean(node.taskType, 32)].filter(Boolean).join("/");
}

function fitEnds(left: string, right: string, width: number, theme: Theme): string {
  if (width <= 0) return "";
  const gapWidth = visibleWidth(COLUMN_GAP);
  if (width <= gapWidth + 1) return bounded(theme.fg("accent", left), width);

  const available = width - gapWidth;
  const desiredRightBudget = Math.min(visibleWidth(right), Math.max(1, Math.ceil(width * 0.48)));
  const minimumLeftBudget = Math.min(available, firstGraphemeWidth(left));
  const leftBudget = Math.max(minimumLeftBudget, available - desiredRightBudget);
  const rightBudget = Math.max(0, available - leftBudget);
  const leftSuffix = visibleWidth(left) > leftBudget && leftBudget > minimumLeftBudget ? "…" : "";
  const renderedLeft = truncateToWidth(theme.fg("accent", left), leftBudget, leftSuffix);
  if (rightBudget === 0) return bounded(renderedLeft, width);

  const minimumRightBudget = firstGraphemeWidth(right);
  const rightSuffix =
    visibleWidth(right) > rightBudget && rightBudget > minimumRightBudget ? "…" : "";
  const renderedRight = truncateToWidth(theme.fg("dim", right), rightBudget, rightSuffix);
  return bounded(`${renderedLeft}${COLUMN_GAP}${renderedRight}`, width);
}

function renderRow(node: AgentNode, width: number, theme: Theme): string {
  const name = clean(node.name, 32) || clean(node.id, 32) || "minion";
  const metadata = metadataLabel(node);
  const summary = clean(node.description ?? node.task);
  const activity = clean(activityLabel(node));
  const richParts = [
    theme.fg("accent", name),
    metadata ? theme.fg("muted", metadata) : "",
    summary ? theme.fg("text", summary) : "",
    theme.fg("dim", activity),
  ].filter(Boolean);
  const rich = richParts.join(COLUMN_GAP);
  if (visibleWidth(rich) <= width) return bounded(rich, width);

  return fitEnds(
    [name, metadata, summary].filter(Boolean).join(COLUMN_GAP),
    activity,
    width,
    theme,
  );
}

function relevantOpenGroup(live: AgentNode[], groups: OrchestrationGroupState): string | undefined {
  const open = groups.getOpenGroup();
  if (!open) return undefined;
  return live.some((node) => node.kind === "orchestrated" && node.groupId === open.groupId)
    ? clean(open.groupId, 64)
    : undefined;
}

/** Stateless fleet rendering apart from a width/theme cache invalidated by runtime changes. */
export class FleetWidgetComponent implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private disposed = false;

  constructor(
    private readonly tree: AgentTree,
    private readonly groups: OrchestrationGroupState,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (this.disposed) return [];
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const live = this.tree
      .getLive()
      .slice()
      .sort((left, right) => left.startTime - right.startTime || left.id.localeCompare(right.id));
    if (live.length === 0) return [];

    const groupId = relevantOpenGroup(live, this.groups);
    const header = `${live.length} active${groupId ? ` · group ${groupId}` : ""}`;
    const lines = [bounded(this.theme.fg("accent", this.theme.bold(header)), width)];
    for (const node of live.slice(0, FLEET_WIDGET_ROW_CAP)) {
      lines.push(renderRow(node, width, this.theme));
    }
    const hidden = live.length - FLEET_WIDGET_ROW_CAP;
    if (hidden > 0) lines.push(bounded(this.theme.fg("muted", `+${hidden} more`), width));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
  }
}

export interface FleetWidgetController {
  destroy(): void;
}

/** Owns the one AgentTree subscription and the injected TUI/component references for a session. */
export function createFleetWidgetController(
  tree: AgentTree,
  groups: OrchestrationGroupState,
  initialUi: ExtensionContext["ui"],
): FleetWidgetController {
  let ui: ExtensionContext["ui"] | undefined = initialUi;
  let tui: TUI | undefined;
  let component: FleetWidgetComponent | undefined;
  let widgetInstalled = false;
  let disposed = false;

  const refresh = (): void => {
    if (disposed || !ui) return;
    if (tree.getLive().length === 0) {
      if (!widgetInstalled) return;
      widgetInstalled = false;
      const priorComponent = component;
      component = undefined;
      tui = undefined;
      priorComponent?.dispose();
      ui.setWidget(FLEET_WIDGET_KEY, undefined);
      return;
    }

    if (!widgetInstalled) {
      widgetInstalled = true;
      ui.setWidget(
        FLEET_WIDGET_KEY,
        (nextTui, theme) => {
          if (disposed) {
            const stale = new FleetWidgetComponent(tree, groups, theme);
            stale.dispose();
            return stale;
          }
          tui = nextTui;
          component = new FleetWidgetComponent(tree, groups, theme);
          return component;
        },
        { placement: "aboveEditor" },
      );
      return;
    }

    component?.invalidate();
    tui?.requestRender();
  };

  const unsubscribe = tree.onChange(refresh);
  refresh();

  return {
    destroy(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      const priorUi = ui;
      const priorComponent = component;
      ui = undefined;
      component = undefined;
      tui = undefined;
      widgetInstalled = false;
      priorComponent?.dispose();
      priorUi?.setWidget(FLEET_WIDGET_KEY, undefined);
    },
  };
}
