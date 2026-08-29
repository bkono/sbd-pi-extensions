import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logger } from "../logger.js";
import { nudgeFor } from "../nudges.js";
import { formatDuration } from "../render.js";
import { NUDGE_EVENTS, type NudgeEvent } from "../task-types.js";
import type { AgentTree } from "../tree.js";
import type { AgentNode, AgentStatus, OrchestrationDomain, TaskType } from "../types.js";
import type { OrchestrationLifecycleEvent } from "./events.js";

export const LIFECYCLE_PACKET_CUSTOM_TYPE = "minion-lifecycle";

/** Modest bound so packets stay cheap in parent history. Full text via show_minion. */
export const CHILD_OUTPUT_CHAR_CAP = 2000;

const SEND_OPTIONS = { triggerTurn: true, deliverAs: "followUp" } as const;

export interface ChangedChildPacket {
  childId: string;
  displayName: string;
  role?: string;
  taskType?: TaskType;
  description?: string;
  domain?: OrchestrationDomain;
  eventClass: NudgeEvent;
  output?: string;
  error?: string;
  nudge: string;
}

export interface StillRunningChildPacket {
  childId: string;
  role?: string;
  taskType?: TaskType;
  description?: string;
  state: AgentStatus;
  elapsedMs?: number;
  lastActivity?: string;
}

export interface LifecyclePacketDetails {
  seq: number;
  groupIds: string[];
  changed: ChangedChildPacket[];
  stillRunning: StillRunningChildPacket[];
}

export interface LifecyclePacketDispatcherDeps {
  getTree: () => AgentTree;
  sendMessage: ExtensionAPI["sendMessage"];
  now?: () => number;
  schedule?: (run: () => void) => void;
}

function isPacketClass(value: string): value is NudgeEvent {
  return (NUDGE_EVENTS as readonly string[]).includes(value);
}

function boundText(text: string | undefined): { text: string; truncated: boolean } | undefined {
  if (text === undefined || text.length === 0) return undefined;
  if (text.length <= CHILD_OUTPUT_CHAR_CAP) return { text, truncated: false };
  return { text: text.slice(0, CHILD_OUTPUT_CHAR_CAP), truncated: true };
}

function fenceUntrusted(label: string, text: string, truncated: boolean): string[] {
  const heading = truncated ? `${label} (truncated; full text via show_minion)` : label;
  return [
    `  --- ${heading} ---`,
    ...text.split("\n").map((line) => `  | ${line}`),
    `  --- end ${label} ---`,
  ];
}

function formatInstruction(nudge: string): string[] {
  const [first, ...rest] = nudge.split("\n");
  const lines = [`  Required judgment: ${first ?? ""}`];
  for (const line of rest) lines.push(`  ${line}`);
  return ["  --- runtime instruction ---", ...lines, "  --- end runtime instruction ---"];
}

function foldEvents(events: OrchestrationLifecycleEvent[]): OrchestrationLifecycleEvent[] {
  const latest = new Map<string, OrchestrationLifecycleEvent>();
  const order: string[] = [];
  for (const event of events) {
    if (!latest.has(event.childId)) order.push(event.childId);
    latest.set(event.childId, event);
  }
  return order
    .map((id) => latest.get(id))
    .filter((event): event is OrchestrationLifecycleEvent => !!event);
}

function stillRunningLine(child: StillRunningChildPacket): string[] {
  const bits = [child.role, child.taskType].filter(Boolean);
  const bracket = bits.length > 0 ? ` [${bits.join(" / ")}]` : "";
  const description = child.description ? ` ${child.description}` : "";
  const lines = [`- ${child.childId}${bracket}${description}`, `  state: ${child.state}`];
  if (child.elapsedMs !== undefined) {
    lines.push(`  elapsed: ${formatDuration(Math.max(0, child.elapsedMs))}`);
  }
  if (child.lastActivity) lines.push(`  activity: ${child.lastActivity}`);
  return lines;
}

function formatChanged(child: ChangedChildPacket): string[] {
  const lines = [`- ${child.childId} ${child.eventClass}`, `  name: ${child.displayName}`];
  if (child.role) lines.push(`  role: ${child.role}`);
  if (child.taskType) lines.push(`  taskType: ${child.taskType}`);
  if (child.description) lines.push(`  description: ${child.description}`);
  if (child.domain) lines.push(`  domain: ${JSON.stringify(child.domain)}`);

  if (child.output) {
    lines.push(
      ...fenceUntrusted(
        "untrusted child output",
        child.output,
        child.output.length >= CHILD_OUTPUT_CHAR_CAP,
      ),
    );
  }
  if (child.error) {
    lines.push(
      ...fenceUntrusted(
        "untrusted child error",
        child.error,
        child.error.length >= CHILD_OUTPUT_CHAR_CAP,
      ),
    );
  }

  lines.push(...formatInstruction(child.nudge));
  return lines;
}

export function formatLifecyclePacket(
  details: Omit<LifecyclePacketDetails, "seq"> & { seq?: number },
): string {
  const lines = ["Orchestration update", "", "Changed:"];
  if (details.changed.length === 0) {
    lines.push("- none");
  } else {
    for (const child of details.changed) {
      lines.push(...formatChanged(child));
      lines.push("");
    }
  }

  lines.push("Still running:");
  if (details.stillRunning.length === 0) {
    lines.push("- none");
  } else {
    for (const child of details.stillRunning) {
      lines.push(...stillRunningLine(child));
    }
  }

  lines.push("", "Full transcripts: show_minion <id>");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function toStillRunning(node: AgentNode, now: number): StillRunningChildPacket {
  return {
    childId: node.id,
    role: node.role,
    taskType: node.taskType,
    description: node.description,
    state: node.status,
    elapsedMs: now - node.startTime,
    lastActivity: node.lastActivity,
  };
}

export class LifecyclePacketDispatcher {
  private queue: OrchestrationLifecycleEvent[] = [];
  private scheduled = false;
  private seq = 0;
  private closed = false;
  private readonly schedule: (run: () => void) => void;
  private readonly now: () => number;

  constructor(private readonly deps: LifecyclePacketDispatcherDeps) {
    this.schedule = deps.schedule ?? queueMicrotask;
    this.now = deps.now ?? Date.now;
  }

  enqueue(event: OrchestrationLifecycleEvent): void {
    if (this.closed) return;
    if (!isPacketClass(event.class)) return;
    const node = this.deps.getTree().get(event.childId);
    if (node?.kind !== "orchestrated") return;

    this.queue.push(event);
    this.scheduleDrain();
  }

  reset(): void {
    this.queue = [];
    this.scheduled = false;
    this.seq = 0;
  }

  close(): void {
    this.closed = true;
    this.reset();
  }

  open(): void {
    this.closed = false;
    this.reset();
  }

  private scheduleDrain(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      if (this.closed) {
        this.queue = [];
        return;
      }
      this.drain();
    });
  }

  private drain(): void {
    const batch: OrchestrationLifecycleEvent[] = [];
    let packet: LifecyclePacketDetails | undefined;
    // Fold every event that arrives before submit. Queue drain, not a timer.
    do {
      batch.push(...this.queue.splice(0));
      packet = this.build(batch);
    } while (this.queue.length > 0);

    if (!packet) return;
    this.submit(packet);
  }

  private build(events: OrchestrationLifecycleEvent[]): LifecyclePacketDetails | undefined {
    const tree = this.deps.getTree();
    const now = this.now();
    const folded = foldEvents(events);
    const changed: ChangedChildPacket[] = [];
    const terminalChanged = new Set<string>();
    const groupIds: string[] = [];

    for (const event of folded) {
      if (!isPacketClass(event.class)) continue;
      const node = tree.get(event.childId);
      if (node?.kind !== "orchestrated") continue;

      if (!groupIds.includes(event.groupId)) groupIds.push(event.groupId);
      if (event.class !== "parentMessage") terminalChanged.add(event.childId);

      changed.push({
        childId: node.id,
        displayName: node.name,
        role: node.role,
        taskType: node.taskType,
        description: node.description,
        domain: node.domain,
        eventClass: event.class,
        output: boundText(event.output)?.text,
        error: boundText(event.error ?? node.error)?.text,
        nudge: nudgeFor(
          { taskType: node.taskType, completionNudge: node.completionNudge },
          event.class,
        ),
      });
    }

    if (changed.length === 0) return undefined;

    const seen = new Set<string>();
    const stillRunning: StillRunningChildPacket[] = [];
    for (const groupId of groupIds) {
      for (const node of tree.getOrchestratedGroup(groupId)) {
        if (terminalChanged.has(node.id) || seen.has(node.id) || node.kind !== "orchestrated") {
          continue;
        }
        seen.add(node.id);
        stillRunning.push(toStillRunning(node, now));
      }
    }

    return {
      seq: this.seq + 1,
      groupIds,
      changed,
      stillRunning,
    };
  }

  private submit(packet: LifecyclePacketDetails): void {
    this.seq = packet.seq;
    const content = formatLifecyclePacket(packet);
    const byteSize = Buffer.byteLength(content, "utf8");
    const childIds = packet.changed.map((child) => child.childId);
    const eventClasses = packet.changed.map((child) => child.eventClass);
    const fleetIds = packet.stillRunning.map((child) => child.childId);

    logger.info("packets", "submit", {
      seq: packet.seq,
      childIds,
      eventClasses,
      fleetIds,
      byteSize,
    });

    try {
      this.deps.sendMessage(
        {
          customType: LIFECYCLE_PACKET_CUSTOM_TYPE,
          content,
          display: true,
          details: packet,
        },
        SEND_OPTIONS,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error("packets", "submit-failed", { seq: packet.seq, error });
    }
  }
}

export function createLifecyclePacketDispatcher(
  deps: LifecyclePacketDispatcherDeps,
): LifecyclePacketDispatcher {
  return new LifecyclePacketDispatcher(deps);
}
