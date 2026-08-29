import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import { logger } from "../logger.js";
import { generateId } from "../minions.js";
import type { AgentTree } from "../tree.js";
import type { AgentKind, AgentStatus } from "../types.js";

/** Bound child send target for the parent session. Not a child id. */
export const PARENT_RECIPIENT_ID = "parent";

export const LIST_MINION_PEERS_TOOL = "list_minion_peers";
export const SEND_MINION_PEER_TOOL = "send_minion_peer";

/** Names unioned into the child extraTools allowlist hook. Spawn never gets these. */
export const ORCHESTRATED_COMM_TOOL_NAMES = [
  LIST_MINION_PEERS_TOOL,
  SEND_MINION_PEER_TOOL,
] as const;

export type OrchestratedCommToolName = (typeof ORCHESTRATED_COMM_TOOL_NAMES)[number];

/** Parent tools that must never be injected into children. */
export const PARENT_ONLY_MINION_TOOLS = [
  "orchestrate",
  "spawn",
  "halt",
  "send_minion_message",
] as const;

export const COMM_SEND_STATUS = {
  queued: "queued",
  recipientTerminal: "recipient-terminal",
  invalidRecipient: "invalid-recipient",
} as const;

export type CommSendStatus = (typeof COMM_SEND_STATUS)[keyof typeof COMM_SEND_STATUS];

export const ListMinionPeersParams = Type.Object(
  {},
  { description: "List peers in this orchestration group. No parameters." },
);
export type ListMinionPeersParams = Static<typeof ListMinionPeersParams>;

export const SendMinionPeerParams = Type.Object({
  to: Type.String({
    description: `Recipient child id in this group, or "${PARENT_RECIPIENT_ID}" to message the parent.`,
  }),
  body: Type.String({
    description:
      "Message body. Delivery is best-effort and non-blocking. Sender identity is bound.",
  }),
});
export type SendMinionPeerParams = Static<typeof SendMinionPeerParams>;

export interface MinionPeerInfo {
  id: string;
  role?: string;
  taskType?: string;
  description?: string;
  state: AgentStatus | "parent";
}

export interface ListMinionPeersDetails {
  selfId: string;
  groupId: string;
  peers: MinionPeerInfo[];
}

export interface QueuedMinionMessage {
  id: string;
  from: string;
  to: string;
  groupId: string;
  body: string;
  createdAt: number;
}

export interface CommSendDetails {
  status: CommSendStatus;
  from: string;
  to: string;
  groupId: string;
  messageId?: string;
}

/**
 * Process-local queue. 3.2 owns live delivery; this issue only records.
 * Sender identity is taken from the bound tool, never from the payload.
 */
export class MinionCommMailbox {
  private readonly items: QueuedMinionMessage[] = [];

  list(): readonly QueuedMinionMessage[] {
    return this.items;
  }

  enqueue(input: { from: string; to: string; groupId: string; body: string }): QueuedMinionMessage {
    const message: QueuedMinionMessage = {
      id: generateId(),
      from: input.from,
      to: input.to,
      groupId: input.groupId,
      body: input.body,
      createdAt: Date.now(),
    };
    this.items.push(message);
    return message;
  }
}

export interface CommInjectInput {
  childId: string;
  groupId: string;
  tree: AgentTree;
  mailbox: MinionCommMailbox;
  /** "orchestrated" in production; tests may pass spawn to assert it logs and injects nothing. */
  kind?: AgentKind;
}

export interface InjectedCommTools {
  tools: ToolDefinition[];
  names: string[];
}

function parentPeer(): MinionPeerInfo {
  return {
    id: PARENT_RECIPIENT_ID,
    role: "parent",
    description: "Parent session",
    state: "parent",
  };
}

function peerFromNode(node: {
  id: string;
  role?: string;
  taskType?: string;
  description?: string;
  status: AgentStatus;
}): MinionPeerInfo {
  return {
    id: node.id,
    role: node.role,
    taskType: node.taskType,
    description: node.description,
    state: node.status,
  };
}

function formatPeerList(details: ListMinionPeersDetails): string {
  const lines = [
    `Group ${details.groupId} (you are ${details.selfId}): ${details.peers.length} peer(s).`,
  ];
  for (const peer of details.peers) {
    const role = peer.role ? ` role=${peer.role}` : "";
    const taskType = peer.taskType ? ` taskType=${peer.taskType}` : "";
    const description = peer.description ? `: ${peer.description}` : "";
    lines.push(`- ${peer.id} [${peer.state}]${role}${taskType}${description}`);
  }
  return lines.join("\n");
}

function createListMinionPeersTool(input: CommInjectInput): ToolDefinition {
  const { childId, groupId, tree } = input;
  return {
    name: LIST_MINION_PEERS_TOOL,
    label: "List Minion Peers",
    description:
      "List members of this orchestration group (id, role, taskType, description, state), including the parent.",
    promptSnippet: "List live and recent peers in this orchestration group",
    promptGuidelines: [
      "Use list_minion_peers to see who else is in the group before sending a message.",
      `Send to the parent with to="${PARENT_RECIPIENT_ID}". Send to a peer with that child's id.`,
    ],
    parameters: ListMinionPeersParams,
    async execute(
      _toolCallId: string,
      _params: ListMinionPeersParams,
    ): Promise<AgentToolResult<ListMinionPeersDetails>> {
      const peers = [parentPeer(), ...tree.listOrchestratedGroup(groupId).map(peerFromNode)];
      const details: ListMinionPeersDetails = { selfId: childId, groupId, peers };
      return {
        content: [{ type: "text", text: formatPeerList(details) }],
        details,
      };
    },
  };
}

function resolveSendStatus(input: CommInjectInput, to: string): CommSendStatus {
  if (to === PARENT_RECIPIENT_ID) return COMM_SEND_STATUS.queued;
  if (to.length === 0 || to === input.childId) return COMM_SEND_STATUS.invalidRecipient;
  const node = input.tree.get(to);
  if (node?.kind !== "orchestrated" || node.groupId !== input.groupId) {
    return COMM_SEND_STATUS.invalidRecipient;
  }
  const live = input.tree.getOrchestratedGroup(input.groupId).some((peer) => peer.id === to);
  return live ? COMM_SEND_STATUS.queued : COMM_SEND_STATUS.recipientTerminal;
}

function createSendMinionPeerTool(input: CommInjectInput): ToolDefinition {
  const { childId, groupId, mailbox } = input;
  return {
    name: SEND_MINION_PEER_TOOL,
    label: "Send Minion Peer",
    description:
      "Send a non-blocking message to a live peer in this group, or to the parent. " +
      "Sender identity is bound by the runtime; you cannot set from.",
    promptSnippet: "Message a live peer or the parent without waiting for a reply",
    promptGuidelines: [
      "Messages succeed only while the recipient is live. Do not wait for a reply.",
      `Use to="${PARENT_RECIPIENT_ID}" for the parent. Peer messages do not start a parent turn.`,
    ],
    parameters: SendMinionPeerParams,
    async execute(
      _toolCallId: string,
      params: SendMinionPeerParams & { from?: unknown },
    ): Promise<AgentToolResult<CommSendDetails>> {
      // Identity is closed over. Ignore any forged `from` the model may pass.
      void params.from;
      const to = typeof params.to === "string" ? params.to.trim() : "";
      const body = typeof params.body === "string" ? params.body : "";
      const status = resolveSendStatus(input, to);
      const details: CommSendDetails = { status, from: childId, to, groupId };

      if (status !== COMM_SEND_STATUS.queued) {
        return {
          content: [{ type: "text", text: `Send failed: ${status}.` }],
          details,
        };
      }

      const message = mailbox.enqueue({ from: childId, to, groupId, body });
      details.messageId = message.id;
      return {
        content: [{ type: "text", text: `Queued message to ${to}.` }],
        details,
      };
    },
  };
}

function assertNoParentTools(tools: ToolDefinition[]): void {
  for (const tool of tools) {
    if ((PARENT_ONLY_MINION_TOOLS as readonly string[]).includes(tool.name)) {
      throw new Error(`refusing to inject parent tool ${tool.name} into a child session`);
    }
  }
}

/**
 * Bind comm tools for one orchestrated child. Sender identity is fixed here.
 * Announce/inspect path intent lands in 3.5 by extending this hook, not a second injector.
 * Spawn must not call this.
 */
export function injectOrchestratedCommTools(input: CommInjectInput): InjectedCommTools {
  const kind = input.kind ?? "orchestrated";
  if (kind !== "orchestrated") {
    logger.info("comm", "inject", { childId: input.childId, tools: [], kind });
    return { tools: [], names: [] };
  }

  const tools = [createListMinionPeersTool(input), createSendMinionPeerTool(input)];
  assertNoParentTools(tools);
  const names = tools.map((tool) => tool.name);
  logger.info("comm", "inject", { childId: input.childId, tools: names, kind });
  return { tools, names };
}
