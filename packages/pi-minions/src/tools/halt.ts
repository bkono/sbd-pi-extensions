import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import { logger } from "../logger.js";
import type { OrchestrationGroupState } from "../orchestration/index.js";
import type { SubsessionManager } from "../subsessions/manager.js";
import type { AgentTree } from "../tree.js";
import type { AgentKind, AgentStatus } from "../types.js";

export const HaltToolParams = Type.Object({
  id: Type.String({
    description:
      "Minion ID or name, orchestration groupId, 'group' for the open group, or 'all' to halt every running minion. Halt group forgets the open group after drain. Does not exit Beadwork goal mode.",
  }),
});

export type HaltToolParams = Static<typeof HaltToolParams>;

export interface HaltedMinion {
  id: string;
  kind: AgentKind;
  groupId?: string;
  status: AgentStatus;
}

export interface HaltResult {
  text: string;
  error?: boolean;
  missing?: boolean;
  halted: HaltedMinion[];
  groupClosed?: string;
}

type HaltManager = Pick<SubsessionManager, "getSessionHandle" | "abortSession">;

function nodeKind(node: { kind?: AgentKind } | undefined): AgentKind {
  return node?.kind ?? "spawn";
}

/**
 * Abort via the same handle.abort() → abortChild → session.abort path as the
 * runner. Tree status is aborted, not failed. Children do not receive halt.
 */
export async function abortAgents(
  ids: string[],
  tree: AgentTree,
  subsessionManager: HaltManager,
): Promise<{ count: number; halted: HaltedMinion[] }> {
  const halted: HaltedMinion[] = [];
  const waits: Promise<unknown>[] = [];

  for (const id of ids) {
    const node = tree.get(id);
    const handle = subsessionManager.getSessionHandle(id);
    if (handle) {
      const wait = handle.wait().catch(() => {});
      waits.push(wait);
    }
    subsessionManager.abortSession(id);
    tree.updateStatus(id, "aborted");
    const after = tree.get(id) ?? node;
    const kind = nodeKind(after);
    const groupId = after?.groupId;
    logger.info("halt", "aborted", { id, kind, groupId, status: "aborted" });
    halted.push({ id, kind, groupId, status: "aborted" });
  }

  await Promise.all(waits);
  return { count: halted.length, halted };
}

async function haltGroup(
  groupId: string,
  tree: AgentTree,
  subsessionManager: HaltManager,
  groups: OrchestrationGroupState,
): Promise<HaltResult> {
  const members = tree.getOrchestratedGroup(groupId);
  const { halted } =
    members.length > 0
      ? await abortAgents(
          members.map((n) => n.id),
          tree,
          subsessionManager,
        )
      : { halted: [] as HaltedMinion[] };

  const open = groups.getOpenGroup();
  const groupClosed = open?.groupId === groupId ? groupId : undefined;
  if (groupClosed) groups.closeGroup(groupId);

  const count = halted.length;
  const forgot = groupClosed ? `. Forgot group ${groupId}.` : ".";
  return {
    text: `Halted ${count} minion${count !== 1 ? "s" : ""} in group ${groupId}${forgot}`,
    halted,
    groupClosed,
  };
}

export async function runHalt(
  id: string,
  tree: AgentTree,
  subsessionManager: HaltManager,
  groups: OrchestrationGroupState,
): Promise<HaltResult> {
  const trimmed = id.trim();

  if (trimmed === "all") {
    const running = tree.getRunning();
    if (running.length === 0) {
      return { text: "No running minions to halt.", halted: [] };
    }
    const { halted } = await abortAgents(
      running.map((n) => n.id),
      tree,
      subsessionManager,
    );
    const open = groups.getOpenGroup();
    if (open) groups.closeGroup(open.groupId);
    const groupClosed = open?.groupId;
    const count = halted.length;
    const forgot = groupClosed ? `. Forgot group ${groupClosed}.` : ".";
    return {
      text: `Halted ${count} minion${count !== 1 ? "s" : ""}${forgot}`,
      halted,
      groupClosed,
    };
  }

  if (trimmed === "group") {
    const open = groups.getOpenGroup();
    if (!open) {
      return { text: "No open orchestration group.", error: true, halted: [] };
    }
    return haltGroup(open.groupId, tree, subsessionManager, groups);
  }

  const node = tree.resolve(trimmed);
  if (node) {
    if (node.status !== "running") {
      return {
        text: `Minion ${node.name} (${node.id}) is not running (status: ${node.status}).`,
        halted: [],
      };
    }
    const { halted } = await abortAgents([node.id], tree, subsessionManager);
    return {
      text: `Halted minion ${node.name} (${node.id}).`,
      halted,
    };
  }

  const open = groups.getOpenGroup();
  const live = tree.getOrchestratedGroup(trimmed);
  if (open?.groupId === trimmed || live.length > 0) {
    return haltGroup(trimmed, tree, subsessionManager, groups);
  }

  return { text: `Minion not found: ${trimmed}`, error: true, missing: true, halted: [] };
}

export function halt(
  tree: AgentTree,
  subsessionManager: SubsessionManager,
  groups: OrchestrationGroupState,
) {
  return async function execute(
    _toolCallId: string,
    params: HaltToolParams,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ halted: HaltedMinion[]; groupClosed?: string }>> {
    const result = await runHalt(params.id, tree, subsessionManager, groups);
    if (result.missing) {
      throw new Error(result.text);
    }
    return {
      content: [{ type: "text", text: result.text }],
      details: { halted: result.halted, groupClosed: result.groupClosed },
    };
  };
}
