import type { Static } from "typebox";
import { Type } from "typebox";
import { type TaskType, TaskTypeSchema } from "./task-types.js";

export type { NudgeEvent, TaskType } from "./task-types.js";
export {
  NUDGE_EVENTS,
  NudgeEventSchema,
  TASK_TYPES,
  TaskTypeSchema,
} from "./task-types.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AgentSource = "builtin" | "user" | "project" | "ephemeral";

export function namedAgent(node: { agentName?: string }): string | undefined {
  if (!node.agentName || node.agentName === "ephemeral") return undefined;
  return node.agentName;
}

export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: ThinkingLevel;
  steps?: number;
  timeout?: number;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
  /** Best-effort agent fallback from frontmatter. Not a workflow contract. */
  completionNudge?: string;
}

export type AgentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export type AgentKind = "spawn" | "orchestrated";

/** Runtime-derived work phase. Terminal status is separate and authoritative. */
export type ActivityPhase = "starting" | "thinking" | "tool" | "waiting" | "settling";

export interface ActivitySnapshot {
  phase: ActivityPhase;
  /** Concise trusted summary. Never arbitrary streamed prose. */
  summary: string;
  toolName?: string;
  /** formatToolCall()-quality preview, sanitized and bounded. */
  toolPreview?: string;
  /** Turn count as metadata, not the primary summary. */
  turn?: number;
  updatedAt: number;
  /** Optional sanitized drill-down. Not canonical phase/progress. */
  narrativePreview?: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

export interface SpawnResult {
  exitCode: number;
  status?: AgentStatus;
  finalOutput: string;
  usage: UsageStats;
  error?: string;
}

/** Opaque domain metadata. Minions stores and echoes; it does not interpret ticket semantics. */
export const OrchestrationDomainSchema = Type.Object({
  source: Type.String({
    description: "Opaque domain adapter id. Minions does not interpret it.",
  }),
  scopeId: Type.Optional(Type.String()),
  workItemId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
});
export type OrchestrationDomain = Static<typeof OrchestrationDomainSchema>;

/** Parent-visible comm log. Messaging writes; list/show only read. */
export interface MinionMessage {
  from: string;
  to: string;
  text: string;
  failed?: boolean;
  at?: number;
}

/** Advisory path intent. Path tools write; list/show only read. */
export interface PathIntent {
  path: string;
  ttlMs?: number;
  announcedAt?: number;
  note?: string;
}

export interface AgentNode {
  id: string;
  name: string;
  agentName?: string;
  task: string;
  status: AgentStatus;
  parentId?: string;
  children: string[];
  usage: UsageStats;
  startTime: number;
  endTime?: number;
  exitCode?: number;
  error?: string;
  /** Current runtime activity. Describes work only, not speech or terminal output. */
  activity?: ActivitySnapshot;
  /** lastActivity is activity.summary for compact consumers. */
  lastActivity?: string;
  /** Bounded recent-activity ring. Full transcript remains canonical. */
  activityHistory?: ActivitySnapshot[];
  /** Model used by this minion */
  model?: string;
  /** Origin of this node. Existing add() call sites default to spawn. */
  kind?: AgentKind;
  groupId?: string;
  taskType?: TaskType;
  /** Fleet-readable summary. Stored as provided; never inferred from task. */
  description?: string;
  /** Opaque domain metadata. Not parsed as ticket semantics. */
  domain?: OrchestrationDomain;
  /** Agent completion_nudge snapshot for parent packets when taskType is absent. */
  completionNudge?: string;
  /** Full child output. Canonical large text for show_minion, not packets. */
  output?: string;
  /** Parent-visible messages. Empty until messaging writes. */
  messages?: MinionMessage[];
  /** Advisory path intent. Empty until path tools write. */
  pathIntent?: PathIntent[];
  /** True when the last peer-message delivery failed. */
  peerMessageFailed?: boolean;
  lastPeerError?: string;
}

export const OrchestratedTaskDescriptorSchema = Type.Object({
  task: Type.String({
    description: "Complete child prompt. The caller supplies this; it is not wrapped.",
  }),
  description: Type.String({
    description: "Required short fleet-readable summary. Do not infer from task.",
  }),
  agent: Type.Optional(
    Type.String({
      description:
        "Discovered agent/template name. Same loader as spawn. Call list_agents if unsure.",
    }),
  ),
  taskType: Type.Optional(TaskTypeSchema),
  model: Type.Optional(Type.String({ description: "Override the child's model" })),
  domain: Type.Optional(OrchestrationDomainSchema),
});
export type OrchestratedTaskDescriptor = Static<typeof OrchestratedTaskDescriptorSchema>;

export const OrchestrateInputSchema = Type.Object({
  groupId: Type.Optional(
    Type.String({
      description:
        "Existing group to join. Omit to create if none is open, else join the open group.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Group create only. Must already exist. Immutable after create. Default: parent cwd.",
    }),
  ),
  tasks: Type.Array(OrchestratedTaskDescriptorSchema, {
    minItems: 1,
    description: "Task descriptors to register. Description is required on each.",
  }),
});
export type OrchestrateInput = Static<typeof OrchestrateInputSchema>;

export const OrchestrateAcceptedSchema = Type.Object({
  childId: Type.String(),
  description: Type.String(),
  state: Type.Literal("starting"),
});
export type OrchestrateAccepted = Static<typeof OrchestrateAcceptedSchema>;

export const OrchestrateRejectedSchema = Type.Object({
  index: Type.Number(),
  reason: Type.String(),
  value: Type.Optional(Type.String()),
});
export type OrchestrateRejected = Static<typeof OrchestrateRejectedSchema>;

export const OrchestrateResultSchema = Type.Object({
  groupId: Type.String(),
  accepted: Type.Array(OrchestrateAcceptedSchema),
  rejected: Type.Array(OrchestrateRejectedSchema),
});
export type OrchestrateResult = Static<typeof OrchestrateResultSchema>;
