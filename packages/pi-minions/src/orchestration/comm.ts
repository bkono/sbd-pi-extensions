import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import { logger } from "../logger.js";
import { generateId } from "../minions.js";
import type { AgentTree } from "../tree.js";
import type { AgentKind, AgentStatus, MinionMessage } from "../types.js";
import type { OrchestrationGroupState } from "./group-state.js";

/** Bound child send target for the parent session. Not a child id. */
export const PARENT_RECIPIENT_ID = "parent";

export const LIST_MINION_PEERS_TOOL = "list_minion_peers";
export const SEND_MINION_PEER_TOOL = "send_minion_peer";
export const SEND_MINION_MESSAGE_TOOL = "send_minion_message";

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
  SEND_MINION_MESSAGE_TOOL,
] as const;

/** UTF-8 body cap. Test the boundary; this is not a rate limit. */
export const MAX_MINION_MESSAGE_BYTES = 4096;

/** Per-recipient in-memory pending (undelivered) depth. mailbox-full at this cap. */
export const MAX_MAILBOX_QUEUE_DEPTH = 16;

const TERMINAL_STATUSES = new Set<AgentStatus>(["completed", "failed", "aborted"]);

export const COMM_SEND_STATUS = {
  queued: "queued",
  recipientTerminal: "recipient-terminal",
  invalidRecipient: "invalid-recipient",
  groupNotOpen: "group-not-open",
  mailboxFull: "mailbox-full",
  bodyTooLarge: "body-too-large",
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

export const SendMinionMessageParams = Type.Object({
  to: Type.String({
    description: "Live child id in the open orchestration group.",
  }),
  body: Type.String({
    description:
      "Message body. Best-effort, non-blocking. Does not wait for a reply. Peer mail does not start a parent turn.",
  }),
});
export type SendMinionMessageParams = Static<typeof SendMinionMessageParams>;

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
  bytes: number;
  createdAt: number;
}

export interface CommSendDetails {
  status: CommSendStatus;
  from: string;
  to: string;
  groupId: string;
  messageId?: string;
  bytes: number;
  parentTurnTriggered: false;
}

export interface SendMinionMessageInput {
  from: string;
  to: string;
  groupId: string;
  body: string;
}

/** Live child delivery. followUp is the Pi child-safe send; do not invent another. */
export interface CommMailboxBind {
  getTree: () => AgentTree;
  getGroups: () => Pick<OrchestrationGroupState, "getOpenGroup">;
  isLive: (id: string) => boolean;
  followUp: (id: string, text: string) => Promise<void>;
}

function isTerminalStatus(status: AgentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function bodyBytes(body: string): number {
  return Buffer.byteLength(body, "utf8");
}

/** Prefix so a body starting with `/` cannot trip Pi extension-command checks. */
export function formatMinionMail(from: string, body: string): string {
  return `[minion-mail from ${from}]\n${body}`;
}

function appendNodeMessage(tree: AgentTree, id: string, message: MinionMessage): void {
  const node = tree.get(id);
  if (!node) return;
  tree.updateInspection(id, { messages: [...(node.messages ?? []), message] });
}

function recordSendFailure(
  tree: AgentTree | undefined,
  from: string,
  status: CommSendStatus,
): void {
  if (!tree || from === PARENT_RECIPIENT_ID) return;
  tree.updateInspection(from, { peerMessageFailed: true, lastPeerError: status });
}

function logSend(details: CommSendDetails): void {
  logger.info("comm", "send", {
    messageId: details.messageId,
    from: details.from,
    to: details.to,
    status: details.status,
    bytes: details.bytes,
    parentTurnTriggered: details.parentTurnTriggered,
  });
}

function closedDetails(
  input: SendMinionMessageInput,
  status: CommSendStatus,
  bytes: number,
): CommSendDetails {
  const details: CommSendDetails = {
    status,
    from: input.from,
    to: input.to,
    groupId: input.groupId,
    bytes,
    parentTurnTriggered: false,
  };
  logSend(details);
  return details;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Process-local best-effort mailbox. No durable log, no exactly-once, no wait-for-reply.
 * Live children are delivered via followUp; parent-directed mail does not start a parent turn.
 *
 * `send` is addressed user mail (ACL, size, pending-depth cap).
 * `enqueue` is a non-throwing live-notify for runtime notices (3.5 overlap); not user mail.
 */
export class MinionCommMailbox {
  /** Inspection log. Append-only; ids stay after delivery. Does not drive the cap. */
  private readonly items: QueuedMinionMessage[] = [];
  /** Undelivered user mail per recipient. mailbox-full counts this, not `items`. */
  private readonly pendingByRecipient = new Map<string, QueuedMinionMessage[]>();
  private bindState?: CommMailboxBind;

  constructor(deps?: CommMailboxBind) {
    this.bindState = deps;
  }

  bind(deps: CommMailboxBind): void {
    this.bindState = deps;
  }

  list(): readonly QueuedMinionMessage[] {
    return this.items;
  }

  /** Undelivered pending depth for a recipient. Delivered inspection ids are not counted. */
  depthFor(to: string): number {
    return this.pendingByRecipient.get(to)?.length ?? 0;
  }

  /**
   * Runtime live-notify. Not addressed user mail.
   * Records for inspection and followUp-delivers to a live child.
   * Never throws. Never applies ACL, body-size, or the pending-depth cap.
   * 3.5 overlap uses this so a notice cannot look like a write/mail reject.
   */
  enqueue(input: { from: string; to: string; groupId: string; body: string }): QueuedMinionMessage {
    const message: QueuedMinionMessage = {
      id: generateId(),
      from: input.from,
      to: input.to,
      groupId: input.groupId,
      body: input.body,
      bytes: bodyBytes(input.body),
      createdAt: Date.now(),
    };
    this.items.push(message);
    logger.info("comm", "enqueue", {
      messageId: message.id,
      from: message.from,
      to: message.to,
      bytes: message.bytes,
    });
    try {
      if (this.bindState?.isLive(message.to) === true) {
        // Body as-is: the caller owns the notice text. Do not wrap as minion-mail.
        void Promise.resolve(this.bindState.followUp(message.to, message.body)).catch(
          (err: unknown) => {
            logger.warn("comm", "enqueue-deliver-failed", {
              messageId: message.id,
              from: message.from,
              to: message.to,
              error: errorMessage(err),
            });
          },
        );
      }
    } catch (err: unknown) {
      logger.warn("comm", "enqueue-deliver-failed", {
        messageId: message.id,
        from: message.from,
        to: message.to,
        error: errorMessage(err),
      });
    }
    return message;
  }

  send(input: SendMinionMessageInput): CommSendDetails {
    const from = input.from;
    const to = input.to.trim();
    const body = input.body;
    const groupId = input.groupId;
    const bytes = bodyBytes(body);
    const attempted = { from, to, groupId, body };

    if (bytes > MAX_MINION_MESSAGE_BYTES) {
      const details = closedDetails(attempted, COMM_SEND_STATUS.bodyTooLarge, bytes);
      recordSendFailure(this.bindState?.getTree(), from, details.status);
      return details;
    }

    const open = this.bindState?.getGroups().getOpenGroup();
    if (!open || open.groupId !== groupId) {
      const details = closedDetails(attempted, COMM_SEND_STATUS.groupNotOpen, bytes);
      recordSendFailure(this.bindState?.getTree(), from, details.status);
      return details;
    }

    if (to === PARENT_RECIPIENT_ID) {
      if (from === PARENT_RECIPIENT_ID) {
        return closedDetails(attempted, COMM_SEND_STATUS.invalidRecipient, bytes);
      }
      return this.acceptOrMailboxFull(attempted, bytes, false);
    }

    if (to.length === 0 || to === from) {
      const details = closedDetails(attempted, COMM_SEND_STATUS.invalidRecipient, bytes);
      recordSendFailure(this.bindState?.getTree(), from, details.status);
      return details;
    }

    const tree = this.bindState?.getTree();
    const node = tree?.get(to);
    if (node?.kind !== "orchestrated" || node.groupId !== groupId) {
      const details = closedDetails(attempted, COMM_SEND_STATUS.invalidRecipient, bytes);
      recordSendFailure(tree, from, details.status);
      return details;
    }

    const live = this.bindState?.isLive(to) === true && !isTerminalStatus(node.status);
    if (!live) {
      const details = closedDetails(attempted, COMM_SEND_STATUS.recipientTerminal, bytes);
      recordSendFailure(tree, from, details.status);
      return details;
    }

    return this.acceptOrMailboxFull(attempted, bytes, true);
  }

  private acceptOrMailboxFull(
    input: SendMinionMessageInput,
    bytes: number,
    deliverToChild: boolean,
  ): CommSendDetails {
    if (this.depthFor(input.to) >= MAX_MAILBOX_QUEUE_DEPTH) {
      const details = closedDetails(input, COMM_SEND_STATUS.mailboxFull, bytes);
      recordSendFailure(this.bindState?.getTree(), input.from, details.status);
      return details;
    }
    return this.accept(input, bytes, deliverToChild);
  }

  private pushPending(message: QueuedMinionMessage): void {
    const queue = this.pendingByRecipient.get(message.to);
    if (queue) queue.push(message);
    else this.pendingByRecipient.set(message.to, [message]);
  }

  private accept(
    input: SendMinionMessageInput,
    bytes: number,
    deliverToChild: boolean,
  ): CommSendDetails {
    const message: QueuedMinionMessage = {
      id: generateId(),
      from: input.from,
      to: input.to,
      groupId: input.groupId,
      body: input.body,
      bytes,
      createdAt: Date.now(),
    };
    this.items.push(message);

    const tree = this.bindState?.getTree();
    const recorded: MinionMessage = {
      from: input.from,
      to: input.to,
      text: input.body,
      at: message.createdAt,
    };
    if (tree) {
      if (input.from !== PARENT_RECIPIENT_ID) appendNodeMessage(tree, input.from, recorded);
      if (input.to !== PARENT_RECIPIENT_ID) appendNodeMessage(tree, input.to, recorded);
    }

    const details: CommSendDetails = {
      status: COMM_SEND_STATUS.queued,
      from: input.from,
      to: input.to,
      groupId: input.groupId,
      messageId: message.id,
      bytes,
      parentTurnTriggered: false,
    };
    logSend(details);

    if (deliverToChild) {
      // Handed to followUp: no longer pending. Inspection id stays in `items`.
      const text = formatMinionMail(input.from, input.body);
      void Promise.resolve(this.bindState?.followUp(input.to, text)).catch((err: unknown) => {
        logger.warn("comm", "deliver-failed", {
          messageId: message.id,
          from: input.from,
          to: input.to,
          error: errorMessage(err),
        });
      });
    } else {
      this.pushPending(message);
    }

    return details;
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

function formatSendResult(details: CommSendDetails): AgentToolResult<CommSendDetails> {
  const text =
    details.status === COMM_SEND_STATUS.queued
      ? `Queued message to ${details.to}.`
      : `Send failed: ${details.status}.`;
  return { content: [{ type: "text", text }], details };
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
      return formatSendResult(mailbox.send({ from: childId, to, groupId, body }));
    },
  };
}

/**
 * Parent → live child. Not installed on children. from is always "parent".
 */
export function sendMinionMessage(deps: {
  mailbox: MinionCommMailbox;
  groups: Pick<OrchestrationGroupState, "getOpenGroup">;
}) {
  return async function execute(
    _toolCallId: string,
    params: SendMinionMessageParams & { from?: unknown },
    _signal?: AbortSignal,
    _onUpdate?: unknown,
    _ctx?: unknown,
  ): Promise<AgentToolResult<CommSendDetails>> {
    void params.from;
    const to = typeof params.to === "string" ? params.to.trim() : "";
    const body = typeof params.body === "string" ? params.body : "";
    const open = deps.groups.getOpenGroup();
    if (!open) {
      const details: CommSendDetails = {
        status: COMM_SEND_STATUS.groupNotOpen,
        from: PARENT_RECIPIENT_ID,
        to,
        groupId: "",
        bytes: bodyBytes(body),
        parentTurnTriggered: false,
      };
      logSend(details);
      return formatSendResult(details);
    }
    return formatSendResult(
      deps.mailbox.send({
        from: PARENT_RECIPIENT_ID,
        to,
        groupId: open.groupId,
        body,
      }),
    );
  };
}

export function createSendMinionMessageTool(deps: {
  mailbox: MinionCommMailbox;
  groups: Pick<OrchestrationGroupState, "getOpenGroup">;
}): ToolDefinition {
  return {
    name: SEND_MINION_MESSAGE_TOOL,
    label: "Send Minion Message",
    description:
      "Send a non-blocking message to a live orchestrated child in the open group. " +
      "Does not wait for a reply. Not available to children.",
    promptSnippet: "Message a live orchestrated minion without waiting",
    promptGuidelines: [
      "Messages succeed only while the recipient is live. Do not wait for a reply.",
      "Peer and parent-to-child mail does not start a parent turn.",
    ],
    parameters: SendMinionMessageParams,
    execute: sendMinionMessage(deps),
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
