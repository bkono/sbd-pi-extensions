import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { OrchestrateInput, OrchestrateResult } from "../types.js";

export function summarizeOrchestrate(
  result: Pick<OrchestrateResult, "accepted" | "rejected">,
): string {
  return `${result.accepted.length} starting, ${result.rejected.length} rejected`;
}

export function formatRejectedLine(item: OrchestrateResult["rejected"][number]): string {
  const extra = item.value && !item.reason.includes(item.value) ? ` (${item.value})` : "";
  return `- [${item.index}] ${item.reason}${extra}`;
}

export function formatOrchestrateText(result: OrchestrateResult): string {
  const summary = summarizeOrchestrate(result);
  const heading =
    result.accepted.length === 0
      ? `Orchestration rejected: ${summary}.`
      : `Orchestrated group ${result.groupId}: ${summary}.`;
  const lines = [heading];
  if (result.accepted.length > 0) {
    lines.push("Accepted:");
    for (const item of result.accepted) {
      lines.push(`- ${item.childId} starting: ${item.description}`);
    }
  }
  if (result.rejected.length > 0) {
    lines.push("Rejected:");
    for (const item of result.rejected) {
      lines.push(formatRejectedLine(item));
    }
  }
  return lines.join("\n");
}

export function renderOrchestrateCall(
  args: Record<string, unknown>,
  theme: Theme,
  _ctx: unknown,
): Text {
  const tasks = Array.isArray(args.tasks) ? (args.tasks as OrchestrateInput["tasks"]) : [];
  const n = tasks.length;
  const first = typeof tasks[0]?.description === "string" ? tasks[0].description.trim() : "";
  const preview = first.length > 60 ? `${first.slice(0, 60)}…` : first;

  let text = theme.fg("toolTitle", theme.bold("orchestrate "));
  text += theme.fg("accent", "registered");
  if (n > 0) {
    text += theme.fg("muted", ` [${n} task${n !== 1 ? "s" : ""}]`);
  }
  if (preview) {
    text += theme.fg("dim", ` ${preview}`);
  }
  return new Text(text, 0, 0);
}

function contentText(result: AgentToolResult<OrchestrateResult | undefined>): string {
  const block = result.content.find((item) => item.type === "text");
  return block && "text" in block ? String(block.text) : "";
}

export function renderOrchestrateResult(
  result: AgentToolResult<OrchestrateResult | undefined>,
  _options: ToolRenderResultOptions,
  theme: Theme,
  ctx: { isError: boolean },
): Text {
  const details = result.details;
  if (details) {
    const summary = summarizeOrchestrate(details);
    const allRejected = details.accepted.length === 0;
    const headingColor = allRejected || ctx.isError ? "error" : "accent";
    const lines = [theme.fg(headingColor, summary)];
    for (const item of details.accepted) {
      lines.push(theme.fg("muted", `- ${item.childId} starting: ${item.description}`));
    }
    for (const item of details.rejected) {
      lines.push(theme.fg("error", formatRejectedLine(item)));
    }
    return new Text(lines.join("\n"), 0, 0);
  }

  const fallback = contentText(result);
  const color = ctx.isError ? "error" : "muted";
  const text = fallback || (ctx.isError ? "Orchestration rejected." : "Orchestrate registered.");
  return new Text(theme.fg(color, text), 0, 0);
}
