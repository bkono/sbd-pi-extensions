import { logger } from "./logger.js";
import type {
  AgentKind,
  AgentNode,
  AgentStatus,
  OrchestrationDomain,
  TaskType,
  UsageStats,
} from "./types.js";
import { emptyUsage } from "./types.js";

const TERMINAL_STATUSES = new Set<AgentStatus>(["completed", "failed", "aborted"]);

function isTerminalStatus(status: AgentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface AddAgentOptions {
  parentId?: string;
  agentName?: string;
  model?: string;
  kind?: AgentKind;
  groupId?: string;
  role?: string;
  taskType?: TaskType;
  description?: string;
  domain?: OrchestrationDomain;
  completionNudge?: string;
}

export class AgentTree {
  private nodes = new Map<string, AgentNode>();
  private listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  add(id: string, name: string, task: string, options?: AddAgentOptions): AgentNode;
  add(
    id: string,
    name: string,
    task: string,
    parentId?: string,
    agentName?: string,
    model?: string,
  ): AgentNode;
  add(
    id: string,
    name: string,
    task: string,
    parentIdOrOptions?: string | AddAgentOptions,
    agentName?: string,
    model?: string,
  ): AgentNode {
    const options: AddAgentOptions =
      typeof parentIdOrOptions === "object" && parentIdOrOptions !== null
        ? parentIdOrOptions
        : { parentId: parentIdOrOptions, agentName, model };

    const kind = options.kind ?? "spawn";
    const node: AgentNode = {
      id,
      name,
      agentName: options.agentName,
      task,
      model: options.model,
      status: "running",
      parentId: options.parentId,
      children: [],
      usage: emptyUsage(),
      startTime: Date.now(),
      kind,
      groupId: options.groupId,
      role: options.role,
      taskType: options.taskType,
      description: options.description,
      domain: options.domain,
      completionNudge: options.completionNudge,
    };
    this.nodes.set(id, node);

    if (options.parentId) {
      const parent = this.nodes.get(options.parentId);
      if (parent) parent.children.push(id);
    }

    logger.info("tree", "add", {
      id,
      kind,
      groupId: options.groupId,
      taskType: options.taskType,
      description: options.description,
    });

    this.notify();
    return node;
  }

  get(id: string): AgentNode | undefined {
    return this.nodes.get(id);
  }

  /** Find a node by ID or by minion name. ID takes priority. */
  resolve(idOrName: string): AgentNode | undefined {
    const byId = this.nodes.get(idOrName);
    if (byId) return byId;

    // Fall back to name match (most recent if multiple share a name)
    let match: AgentNode | undefined;
    for (const node of this.nodes.values()) {
      if (node.name === idOrName) {
        if (!match || node.startTime > match.startTime) match = node;
      }
    }

    return match;
  }

  getRunning(): AgentNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.status === "running");
  }

  /** Live orchestrated members of one group. Spawn and terminal nodes are excluded. */
  getOrchestratedGroup(groupId: string): AgentNode[] {
    return Array.from(this.nodes.values()).filter(
      (n) => n.kind === "orchestrated" && n.groupId === groupId && !isTerminalStatus(n.status),
    );
  }

  /** Orchestrated members of one group, including terminal. Spawn excluded. */
  listOrchestratedGroup(groupId: string): AgentNode[] {
    return Array.from(this.nodes.values()).filter(
      (n) => n.kind === "orchestrated" && n.groupId === groupId,
    );
  }

  /** Live nodes with this domain.workItemId. String equality only; not ticket ownership. */
  getLiveByWorkItemId(workItemId: string): AgentNode[] {
    return Array.from(this.nodes.values()).filter(
      (n) => n.domain?.workItemId === workItemId && !isTerminalStatus(n.status),
    );
  }

  getRoots(): AgentNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.parentId === undefined);
  }

  getDepth(id: string): number {
    const node = this.nodes.get(id);
    if (!node) return 0;

    let depth = 0;
    let current = node;
    while (current.parentId) {
      const parent = this.nodes.get(current.parentId);
      if (!parent) break;

      depth++;
      current = parent;
    }

    return depth;
  }

  updateStatus(id: string, status: AgentStatus, exitCode?: number, error?: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    node.status = status;
    if (exitCode !== undefined) node.exitCode = exitCode;
    if (error !== undefined) node.error = error;
    if (status !== "running" && status !== "pending") node.endTime = Date.now();

    this.notify();
  }

  updateUsage(id: string, partial: Partial<UsageStats>): void {
    const node = this.nodes.get(id);
    if (!node) return;

    Object.assign(node.usage, partial);
    this.notify();
  }

  getTotalUsage(): UsageStats {
    const total = emptyUsage();

    for (const node of this.nodes.values()) {
      total.input += node.usage.input;
      total.output += node.usage.output;
      total.cacheRead += node.usage.cacheRead;
      total.cacheWrite += node.usage.cacheWrite;
      total.cost += node.usage.cost;
      total.contextTokens += node.usage.contextTokens;
      total.turns += node.usage.turns;
    }
    return total;
  }

  updateActivity(id: string, activity: string): void {
    const node = this.nodes.get(id);
    if (node) {
      node.lastActivity = activity;
      this.notify();
    }
  }

  logActivity(id: string, activity: string): void {
    const node = this.nodes.get(id);
    if (node) {
      node.lastActivity = activity;
      if (!node.activityHistory) node.activityHistory = [];
      node.activityHistory.push(activity);
      this.notify();
    }
  }

  setActivityHistory(id: string, history: string[]): void {
    const node = this.nodes.get(id);
    if (node) {
      node.activityHistory = [...history];
      this.notify();
    }
  }

  /** Inspection fields for list/show. Messaging and path tools write; this only stores. */
  updateInspection(
    id: string,
    patch: Partial<
      Pick<AgentNode, "output" | "messages" | "pathIntent" | "peerMessageFailed" | "lastPeerError">
    >,
  ): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (patch.output !== undefined) node.output = patch.output;
    if (patch.messages !== undefined) node.messages = patch.messages;
    if (patch.pathIntent !== undefined) node.pathIntent = patch.pathIntent;
    if (patch.peerMessageFailed !== undefined) node.peerMessageFailed = patch.peerMessageFailed;
    if (patch.lastPeerError !== undefined) node.lastPeerError = patch.lastPeerError;
    this.notify();
  }

  remove(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    // Remove children recursively first
    for (const childId of [...node.children]) {
      this.remove(childId);
    }

    // Remove from parent's children list
    if (node.parentId) {
      const parent = this.nodes.get(node.parentId);
      if (parent) {
        parent.children = parent.children.filter((c) => c !== id);
      }
    }

    this.nodes.delete(id);
    this.notify();
  }
}
