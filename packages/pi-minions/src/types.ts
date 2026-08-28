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

export type AgentSource = "user" | "project" | "ephemeral";

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
  /** Best-effort role fallback from frontmatter. Not a workflow contract. */
  completionNudge?: string;
}

export type AgentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export type AgentKind = "spawn" | "orchestrated";

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
  /** Live activity line, e.g. "→ $ grep -r TODO src/" */
  lastActivity?: string;
  /** Persistent activity history for observability widget */
  activityHistory?: string[];
  /** Model used by this minion */
  model?: string;
  /** Origin of this node. Existing add() call sites default to spawn. */
  kind?: AgentKind;
  groupId?: string;
  /** Open agent role/template name. Not a closed enum. */
  role?: string;
  taskType?: TaskType;
  /** Fleet-readable summary. Stored as provided; never inferred from task. */
  description?: string;
  /** Opaque domain metadata. Not parsed as ticket semantics. */
  domain?: OrchestrationDomain;
}

export const OrchestratedTaskDescriptorSchema = Type.Object({
  task: Type.String({
    description: "Complete child prompt. The caller supplies this; it is not wrapped.",
  }),
  description: Type.String({
    description: "Required short fleet-readable summary. Do not infer from task.",
  }),
  role: Type.Optional(
    Type.String({
      description: "Open agent role/template name. Not a closed enum.",
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
});
export type OrchestrateRejected = Static<typeof OrchestrateRejectedSchema>;

export const OrchestrateResultSchema = Type.Object({
  groupId: Type.String(),
  accepted: Type.Array(OrchestrateAcceptedSchema),
  rejected: Type.Array(OrchestrateRejectedSchema),
});
export type OrchestrateResult = Static<typeof OrchestrateResultSchema>;
