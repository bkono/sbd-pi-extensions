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

/** Resolve current session state on every turn; no context or prompt appendix is retained. */
export function createLiveGroupPromptHandler(
  getTree: () => AgentTree,
  getGroups: () => OrchestrationGroupState,
): (event: BeforeAgentStartPromptEvent) => { systemPrompt: string } | undefined {
  return (event) => {
    const group = getGroups().getOpenGroup();
    if (!group || getTree().getOrchestratedGroup(group.groupId).length === 0) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${formatLiveGroupInvariant(group.groupId)}`,
    };
  };
}
