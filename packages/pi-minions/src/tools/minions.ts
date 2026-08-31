import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import { logger } from "../logger.js";
import { formatDuration, formatUsage } from "../render.js";
import type { SubsessionManager } from "../subsessions/manager.js";
import type { AgentTree } from "../tree.js";
import {
  type ActivitySnapshot,
  type AgentKind,
  type AgentNode,
  type AgentStatus,
  type MinionMessage,
  namedAgent,
  type OrchestrationDomain,
  type PathIntent,
  type TaskType,
} from "../types.js";

export const ListMinionsParams = Type.Object({
  kind: Type.Optional(
    Type.Union([Type.Literal("spawn"), Type.Literal("orchestrated")], {
      description: "Filter by spawn vs orchestrated. Omit to list both.",
    }),
  ),
  groupId: Type.Optional(
    Type.String({ description: "Filter to orchestrated minions in this group." }),
  ),
  status: Type.Optional(
    Type.String({
      description: "Filter by status (running, completed, failed, aborted, pending).",
    }),
  ),
});
export type ListMinionsParams = Static<typeof ListMinionsParams>;

export interface MinionInfo {
  id: string;
  name: string;
  kind: AgentKind;
  task: string;
  status: AgentStatus;
  description?: string;
  groupId?: string;
  agent?: string;
  taskType?: TaskType;
  domain?: OrchestrationDomain;
  agentName?: string;
  model?: string;
  lastActivity?: string;
  activity?: ActivitySnapshot;
  lastMessage?: string;
  peerMessageFailed: boolean;
  lastPeerError?: string;
}

export interface ShowMinionInfo extends MinionInfo {
  output: string;
  messages: MinionMessage[];
  pathIntent: PathIntent[];
  activityHistory: ActivitySnapshot[];
}

function nodeKind(node: AgentNode): AgentKind {
  return node.kind ?? "spawn";
}

function peerFailed(node: AgentNode): boolean {
  return node.peerMessageFailed === true || (node.messages?.some((msg) => msg.failed) ?? false);
}

function lastMessageOf(node: AgentNode): string | undefined {
  return node.messages?.at(-1)?.text;
}

export function collectMinions(tree: AgentTree): AgentNode[] {
  const nodes: AgentNode[] = [];

  const visit = (node: AgentNode) => {
    nodes.push(node);
    for (const childId of node.children) {
      const child = tree.get(childId);
      if (child) visit(child);
    }
  };

  for (const root of tree.getRoots()) visit(root);
  return nodes;
}

export function filterMinions(nodes: AgentNode[], params: ListMinionsParams = {}): AgentNode[] {
  return nodes.filter((node) => {
    if (params.kind && nodeKind(node) !== params.kind) return false;
    if (params.groupId && node.groupId !== params.groupId) return false;
    if (params.status && node.status !== params.status) return false;
    return true;
  });
}

export function toInfo(node: AgentNode): MinionInfo {
  return {
    id: node.id,
    name: node.name,
    kind: nodeKind(node),
    task: node.task,
    status: node.status,
    description: node.description,
    groupId: node.groupId,
    agent: namedAgent(node),
    taskType: node.taskType,
    domain: node.domain,
    agentName: node.agentName,
    model: node.model,
    lastActivity: node.lastActivity,
    activity: node.activity,
    lastMessage: lastMessageOf(node),
    peerMessageFailed: peerFailed(node),
    lastPeerError: node.lastPeerError,
  };
}

function displayName(node: AgentNode): string {
  return node.agentName && node.agentName !== "ephemeral"
    ? `${node.agentName} ${node.name}`
    : node.name;
}

function formatListLine(m: MinionInfo): string {
  const model = m.model ? ` [${m.model}]` : "";
  const taskType = m.taskType ? ` ${m.taskType}` : "";
  const group = m.kind === "orchestrated" && m.groupId ? ` group=${m.groupId}` : "";
  const agent = m.agent ? ` agent=${m.agent}` : "";
  const summary = m.description ?? m.task;
  const activity = m.lastActivity ? ` -- ${m.lastActivity}` : "";
  const peer = m.peerMessageFailed ? " [peer-failed]" : "";
  return `  ${m.name} (${m.id}) ${m.kind} [${m.status}]${taskType}${group}${agent}${model}: ${summary}${activity}${peer}`;
}

function logInspect(
  scope: string,
  msg: string,
  node: Pick<MinionInfo, "id" | "kind" | "groupId" | "status">,
) {
  logger.info(scope, msg, {
    id: node.id,
    kind: node.kind,
    groupId: node.groupId,
    status: node.status,
  });
}

export function listMinions(tree: AgentTree) {
  return async function execute(
    _toolCallId: string,
    params: ListMinionsParams,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ minions: MinionInfo[] }>> {
    const minions = filterMinions(collectMinions(tree), params ?? {}).map(toInfo);
    for (const m of minions) logInspect("list_minions", "listed", m);

    const lines: string[] = [];
    if (minions.length === 0) {
      lines.push("No active minions.");
    } else {
      lines.push(`Minions (${minions.length}):`);
      for (const m of minions) lines.push(formatListLine(m));
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { minions },
    };
  };
}

function formatDomain(domain: OrchestrationDomain | undefined): string {
  if (!domain) return "(none)";
  const parts = [`source=${domain.source}`];
  if (domain.scopeId) parts.push(`scopeId=${domain.scopeId}`);
  if (domain.workItemId) parts.push(`workItemId=${domain.workItemId}`);
  if (domain.title) parts.push(`title=${domain.title}`);
  return parts.join(" ");
}

function formatPeer(info: MinionInfo): string {
  if (info.peerMessageFailed) {
    return info.lastPeerError ? `failed (${info.lastPeerError})` : "failed";
  }
  return "none";
}

export function buildShowMinion(
  tree: AgentTree,
  target: string,
  subsessionManager?: Pick<SubsessionManager, "getTerminal" | "parseSessionOutput">,
): { text: string; info: ShowMinionInfo } | null {
  const node = tree.resolve(target);
  if (!node) return null;

  const infoBase = toInfo(node);
  const terminal = subsessionManager?.getTerminal(node.id);
  const output =
    node.output ?? terminal?.output ?? subsessionManager?.parseSessionOutput?.(node.id) ?? "";
  const messages = node.messages ?? [];
  const pathIntent = node.pathIntent ?? [];
  const history = node.activityHistory ?? [];
  const info: ShowMinionInfo = {
    ...infoBase,
    output,
    messages,
    pathIntent,
    activityHistory: history,
  };

  const lines: string[] = [];
  lines.push(`${displayName(node)} (${node.id})`);
  lines.push(`  Kind: ${info.kind}`);
  lines.push(`  Status: ${node.status}`);
  if (info.kind === "orchestrated") {
    lines.push(`  Group: ${node.groupId ?? "(none)"}`);
    lines.push(`  Agent: ${info.agent ?? "(none)"}`);
    lines.push(`  Task type: ${node.taskType ?? "(none)"}`);
    lines.push(`  Description: ${node.description ?? "(none)"}`);
    lines.push(`  Domain: ${formatDomain(node.domain)}`);
  }
  lines.push(`  Task: ${node.task}`);
  if (node.model) lines.push(`  Model: ${node.model}`);
  if (info.activity) {
    lines.push(`  Activity: ${info.activity.phase} — ${info.activity.summary}`);
    if (info.activity.turn !== undefined) lines.push(`  Turn: ${info.activity.turn}`);
    if (info.activity.narrativePreview) {
      lines.push(`  Narrative preview: ${info.activity.narrativePreview}`);
    }
  } else {
    lines.push("  Activity: (none)");
  }
  lines.push(`  Last message: ${info.lastMessage ?? "(none)"}`);
  lines.push(`  Peer message: ${formatPeer(info)}`);

  if (node.status === "running") {
    lines.push(`  Running for: ${formatDuration(Date.now() - node.startTime)}`);
  }

  if (node.endTime) lines.push(`  Duration: ${formatDuration(node.endTime - node.startTime)}`);
  const usageText = formatUsage(node.usage);
  lines.push(`  Usage: ${usageText || "N/A"}`);
  if (node.error) lines.push(`  Error: ${node.error}`);

  lines.push("  Output:");
  if (output.length > 0) {
    for (const line of output.split("\n")) lines.push(`    ${line}`);
  } else {
    lines.push("    (none)");
  }

  lines.push("  Messages:");
  if (messages.length > 0) {
    for (const msg of messages) {
      const failed = msg.failed ? " [failed]" : "";
      lines.push(`    ${msg.from} -> ${msg.to}: ${msg.text}${failed}`);
    }
  } else {
    lines.push("    (none)");
  }

  lines.push("  Path intent:");
  if (pathIntent.length > 0) {
    for (const intent of pathIntent) {
      const ttl = intent.ttlMs !== undefined ? ` ttl=${intent.ttlMs}ms` : "";
      lines.push(`    ${intent.path}${ttl}`);
    }
  } else {
    lines.push("    (none)");
  }

  if (history.length > 0) {
    lines.push("  Recent activity:");
    for (const item of history) lines.push(`    ${item.phase} ${item.summary}`);
  }

  if (node.status === "running") {
    lines.push(`\n  Tip: Use '/minions show ${node.name}' for live activity stream`);
  }

  return { text: lines.join("\n"), info };
}

export function buildShowMinionText(
  tree: AgentTree,
  target: string,
  subsessionManager?: Pick<SubsessionManager, "getTerminal" | "parseSessionOutput">,
): string | null {
  return buildShowMinion(tree, target, subsessionManager)?.text ?? null;
}

export const ShowMinionParams = Type.Object({
  target: Type.String({ description: "Minion ID or name to inspect" }),
});
export type ShowMinionParams = Static<typeof ShowMinionParams>;

export function showMinion(
  tree: AgentTree,
  subsessionManager?: Pick<SubsessionManager, "getTerminal" | "parseSessionOutput">,
) {
  return async function execute(
    _toolCallId: string,
    params: ShowMinionParams,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<ShowMinionInfo>> {
    const shown = buildShowMinion(tree, params.target, subsessionManager);
    if (shown === null) {
      throw new Error(`Minion not found: ${params.target}`);
    }
    logInspect("show_minion", "show", shown.info);
    return { content: [{ type: "text", text: shown.text }], details: shown.info };
  };
}
