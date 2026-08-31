import type { PathOverlapLog } from "../coordination/index.js";
import type { AgentTree } from "../tree.js";
import type { MinionCommMailbox } from "./comm.js";
import type { LifecycleAuthority, OrchestrationGroupState } from "./group-state.js";
import type { LifecyclePacketDispatcher } from "./packets.js";

/**
 * Synchronous cancellation/authority chokepoint. `discardGroup` is not packet ack: it removes
 * queued/unaccepted evidence because an explicit halt/session boundary canceled the group.
 */
export class OrchestrationLifecycleCoordinator {
  constructor(
    private readonly deps: {
      tree: AgentTree;
      groups: OrchestrationGroupState;
      mailbox: MinionCommMailbox;
      overlaps: PathOverlapLog;
      packets: LifecyclePacketDispatcher;
    },
  ) {}

  cleanupAcceptedLifecycle(authority: LifecycleAuthority): boolean {
    if (!this.deps.groups.revokeLifecycle(authority)) return false;
    this.clearExactPathIntent(authority);
    return true;
  }

  discardGroup(groupId: string): void {
    this.deps.packets.discardGroup(groupId);
    this.deps.groups.revokeGroup(groupId);
    this.deps.mailbox.discardGroup(groupId);
    this.deps.overlaps.discardGroup(groupId);
    for (const node of this.deps.tree.listOrchestratedGroup(groupId)) {
      if (node.pathIntent?.length) this.deps.tree.updateInspection(node.id, { pathIntent: [] });
    }
    this.deps.groups.closeGroup(groupId);
  }

  discardOpenGroup(): string | undefined {
    const groupId = this.deps.groups.getOpenGroup()?.groupId;
    if (groupId !== undefined) this.discardGroup(groupId);
    return groupId;
  }

  private clearExactPathIntent(authority: LifecycleAuthority): void {
    const node = this.deps.tree.get(authority.childId);
    if (
      node?.kind !== "orchestrated" ||
      node.groupId !== authority.groupId ||
      node.lifecycleId !== authority.lifecycleId ||
      node.lifecycleEpoch !== authority.epoch
    ) {
      return;
    }
    if (node.pathIntent?.length) this.deps.tree.updateInspection(node.id, { pathIntent: [] });
  }
}
