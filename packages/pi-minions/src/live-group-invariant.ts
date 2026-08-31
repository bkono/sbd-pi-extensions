import { sanitizeActivityText } from "./activity.js";
import type { OrchestrationGroupState } from "./orchestration/group-state.js";
import type { AgentTree } from "./tree.js";

interface BeforeAgentStartPromptEvent {
  systemPrompt: string;
}

export function formatLiveGroupInvariant(groupId: string): string {
  const boundedGroupId = sanitizeActivityText(groupId, 48) || "current";
  return (
    `Background orchestration work is live in group ${boundedGroupId}. ` +
    "You may end this turn, inspect/message/halt minions, or continue safe non-overlapping work. " +
    "Do not claim delegated work or the orchestration goal complete while any child remains live."
  );
}

export function getLiveGroupInvariant(
  tree: AgentTree,
  groups: OrchestrationGroupState,
): string | undefined {
  const group = groups.getOpenGroup();
  if (!group || tree.getOrchestratedGroup(group.groupId).length === 0) return undefined;
  return formatLiveGroupInvariant(group.groupId);
}

/**
 * Pi 0.84.3 has no per-followUp prompt hook. This controller projects the current invariant into
 * the registered orchestrate tool's promptGuidelines, which Pi rebuilds into its base system prompt.
 */
export class LiveGroupSystemPromptController {
  private current: string | undefined;

  constructor(
    private readonly getTree: () => AgentTree,
    private readonly getGroups: () => OrchestrationGroupState,
    private readonly apply: (invariant: string | undefined) => void,
  ) {}

  sync(): void {
    const next = getLiveGroupInvariant(this.getTree(), this.getGroups());
    if (next === this.current) return;
    this.current = next;
    this.apply(next);
  }

  reset(): void {
    if (this.current === undefined) return;
    this.current = undefined;
    this.apply(undefined);
  }
}

/** Resolve current session state on every turn; no context or prompt appendix is retained. */
export function createLiveGroupPromptHandler(
  getTree: () => AgentTree,
  getGroups: () => OrchestrationGroupState,
): (event: BeforeAgentStartPromptEvent) => { systemPrompt: string } | undefined {
  return (event) => {
    const invariant = getLiveGroupInvariant(getTree(), getGroups());
    if (!invariant || event.systemPrompt.includes(invariant)) return undefined;

    return { systemPrompt: `${event.systemPrompt}\n\n${invariant}` };
  };
}
