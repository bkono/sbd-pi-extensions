import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectTrustedActivity } from "../activity.js";
import type { PathOverlapNotice, PathOverlapSnapshot } from "../coordination/index.js";
import { logger } from "../logger.js";
import { nudgeFor } from "../nudges.js";
import { formatDuration } from "../render.js";
import { isNudgeEvent, type NudgeEvent, normalizeTaskType } from "../task-types.js";
import type { AgentTree } from "../tree.js";
import {
  type AgentNode,
  namedAgent,
  type OrchestrationDomain,
  type TaskType,
  type TrustedActivityProjection,
} from "../types.js";
import type { OrchestrationLifecycleEvent } from "./events.js";
import type {
  LifecycleAuthority,
  LifecycleRegistration,
  OrchestrationGroupState,
} from "./group-state.js";

export const LIFECYCLE_PACKET_CUSTOM_TYPE = "minion-lifecycle";
/** Per-field caps remain defense in depth; aggregate budgets below are authoritative. */
export const CHILD_OUTPUT_CHAR_CAP = 2000;
export const PACKET_FIELD_CHAR_CAP = 96;
export const PACKET_NUDGE_CHAR_CAP = 400;
export const MAX_CHANGED_CHILDREN = 8;
export const MAX_STILL_RUNNING_CHILDREN = 16;
export const MAX_PACKET_OVERLAPS = 4;
export const PACKET_CONTENT_BYTE_BUDGET = 9800;
export const PACKET_DETAILS_BYTE_BUDGET = 9800;
export const MAX_DELIVERED_TERMINAL_HISTORY = 256;

const SEND_OPTIONS = { triggerTurn: true, deliverAs: "followUp" } as const;
const FALLBACK_NUDGE = "Inspect the child evidence and decide the next action.";

export interface ChangedChildPacket {
  childId: string;
  displayName: string;
  agent?: string;
  taskType?: TaskType;
  description?: string;
  domain?: OrchestrationDomain;
  eventClass: NudgeEvent;
  output?: string;
  outputTruncated?: boolean;
  error?: string;
  errorTruncated?: boolean;
  nudge: string;
}

export type FleetChildState = "pending" | "running" | "settling";

export interface StillRunningChildPacket {
  childId: string;
  agent?: string;
  taskType?: TaskType;
  description?: string;
  state: FleetChildState;
  elapsedMs?: number;
  activity?: TrustedActivityProjection;
}

export interface LifecyclePacketDetails {
  seq: number;
  groupIds: string[];
  changed: ChangedChildPacket[];
  stillRunning: StillRunningChildPacket[];
  changedCount: number;
  stillRunningCount: number;
  /** Present exactly once for one armed active→idle epoch. */
  groupIdleId?: string;
  /** Advisory overlaps recorded since the last accepted real packet. */
  overlaps: PathOverlapNotice[];
  omittedOverlapCount: number;
}

export interface ParentMailSnapshot {
  ids: string[];
  text: string;
}

export interface LifecyclePacketDispatcherDeps {
  getTree: () => AgentTree;
  getGroups: () => OrchestrationGroupState;
  sendMessage: ExtensionAPI["sendMessage"];
  now?: () => number;
  schedule?: (run: () => void) => void;
  peekOverlaps?: (groupIds: string[]) => PathOverlapSnapshot;
  ackOverlaps?: (ids: readonly string[]) => void;
  peekParentMail?: (authority: LifecycleAuthority) => ParentMailSnapshot | undefined;
  ackParentMail?: (snapshot: ParentMailSnapshot) => void;
  onAcceptedTerminal?: (authority: LifecycleAuthority) => void;
}

interface OwnedLifecycleEvent {
  event: OrchestrationLifecycleEvent;
  registration: LifecycleRegistration;
  terminalKey?: string;
}

interface IdleReservation {
  groupId: string;
  epoch: number;
}

interface BuiltLifecyclePacket {
  details: LifecyclePacketDetails;
  terminalRegistrations: LifecycleRegistration[];
  idleReservation?: IdleReservation;
  parentMailSnapshots: ParentMailSnapshot[];
  overlapIds: string[];
}

function isPacketClass(value: unknown): value is NudgeEvent {
  return isNudgeEvent(value);
}

// ECMA-48 CSI/OSC/DCS/SOS/PM/APC plus C0/C1 controls. Preserve useful line breaks only.
const ANSI_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control sequences from hostile projected text
  /(?:\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[P^_X][\s\S]*?\u001b\\|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~])/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip unsafe C0/C1 controls while preserving newlines
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

function cleanProjectedText(text: string, preserveLines: boolean): string {
  const clean = text
    .replace(/\r\n?/gu, "\n")
    .replace(ANSI_SEQUENCE, "")
    .replace(UNSAFE_CONTROL, "")
    .replace(/\t/gu, "  ");
  if (preserveLines) return clean.replace(/[ \f\v]+\n/gu, "\n").replace(/\n{4,}/gu, "\n\n\n");
  return clean.replace(/\s+/gu, " ").trim();
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const suffix = "…";
  const available = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let result = "";
  let bytes = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > available) break;
    result += point;
    bytes += size;
  }
  return { text: `${result}${suffix}`, truncated: true };
}

function boundText(text: string | undefined): { text: string; truncated: boolean } | undefined {
  if (text === undefined) return undefined;
  const clean = cleanProjectedText(text, true);
  if (clean.length === 0) return undefined;
  return truncateUtf8(clean, CHILD_OUTPUT_CHAR_CAP);
}

function field(text: string | undefined, maxBytes = PACKET_FIELD_CHAR_CAP): string | undefined {
  if (text === undefined) return undefined;
  const clean = cleanProjectedText(text, false);
  if (clean.length === 0) return undefined;
  return truncateUtf8(clean, maxBytes).text || undefined;
}

function boundedDomain(domain: OrchestrationDomain | undefined): OrchestrationDomain | undefined {
  if (!domain) return undefined;
  const source = field(domain.source);
  if (!source) return undefined;
  return {
    source,
    scopeId: field(domain.scopeId),
    workItemId: field(domain.workItemId),
    title: field(domain.title),
  };
}

function boundedActivity(
  activity: TrustedActivityProjection | undefined,
): TrustedActivityProjection | undefined {
  if (!activity) return undefined;
  return {
    ...activity,
    phase: (field(String(activity.phase)) ?? "thinking") as TrustedActivityProjection["phase"],
    summary: field(activity.summary) ?? "active",
    toolPreview: field(activity.toolPreview),
  };
}

function boundedOverlap(notice: PathOverlapNotice): PathOverlapNotice {
  return {
    groupId: field(notice.groupId) ?? "group",
    lifecycleId: field(notice.lifecycleId) ?? "lifecycle",
    epoch: Number.isSafeInteger(notice.epoch) ? notice.epoch : 0,
    childId: field(notice.childId) ?? "child",
    childDescription: field(notice.childDescription),
    path: field(notice.path) ?? "path",
    otherId: field(notice.otherId) ?? "child",
    otherDescription: field(notice.otherDescription),
    otherPath: field(notice.otherPath) ?? "path",
    editAllowed: true,
  };
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

function stillRunningLine(child: StillRunningChildPacket): string[] {
  const bits = [child.agent, child.taskType].filter(Boolean);
  const bracket = bits.length > 0 ? ` [${bits.join(" / ")}]` : "";
  const description = child.description ? ` ${child.description}` : "";
  const lines = [`- ${child.childId}${bracket}${description}`, `  state: ${child.state}`];
  if (child.elapsedMs !== undefined) lines.push(`  elapsed: ${formatDuration(child.elapsedMs)}`);
  if (child.activity) {
    lines.push(`  activity: ${child.activity.summary}`);
    lines.push(`  phase: ${child.activity.phase}`);
  }
  return lines;
}

function overlapLine(notice: PathOverlapNotice): string[] {
  const self = notice.childDescription
    ? `${notice.childId} (${notice.childDescription})`
    : notice.childId;
  const other = notice.otherDescription
    ? `${notice.otherId} (${notice.otherDescription})`
    : notice.otherId;
  return [
    `- ${self} ${notice.path} overlaps ${other} ${notice.otherPath}`,
    "  advisory: edits are not blocked",
    `  suggest: send_minion_peer to ${notice.otherId}`,
  ];
}

function formatChanged(child: ChangedChildPacket): string[] {
  const lines = [`- ${child.childId} ${child.eventClass}`, `  name: ${child.displayName}`];
  if (child.agent) lines.push(`  agent: ${child.agent}`);
  if (child.taskType) lines.push(`  taskType: ${child.taskType}`);
  if (child.description) lines.push(`  description: ${child.description}`);
  if (child.domain) lines.push(`  domain: ${JSON.stringify(child.domain)}`);
  if (child.output) {
    lines.push(...fenceUntrusted("untrusted child output", child.output, !!child.outputTruncated));
  }
  if (child.error) {
    lines.push(...fenceUntrusted("untrusted child error", child.error, !!child.errorTruncated));
  }
  lines.push(...formatInstruction(child.nudge));
  return lines;
}

export function formatLifecyclePacket(
  details: Omit<LifecyclePacketDetails, "seq"> & { seq?: number },
): string {
  const lines = ["Orchestration update", "", "Changed:", `Count: ${details.changedCount}`];
  if (details.changed.length === 0) lines.push("- none");
  else {
    for (const child of details.changed) {
      lines.push(...formatChanged(child));
      lines.push("");
    }
    const omitted = details.changedCount - details.changed.length;
    if (omitted > 0) lines.push(`- +${omitted} more changed events omitted; inspect list_minions`);
  }

  lines.push("Still running:", `Count: ${details.stillRunningCount}`);
  if (details.stillRunning.length === 0) lines.push("- none");
  else {
    for (const child of details.stillRunning) lines.push(...stillRunningLine(child));
    const omitted = details.stillRunningCount - details.stillRunning.length;
    if (omitted > 0) lines.push(`- +${omitted} more active children omitted; inspect list_minions`);
  }

  if (details.groupIdleId) {
    lines.push(
      "",
      `Group idle: ${details.groupIdleId}`,
      "Inspect the evidence and decide the next action.",
    );
  }

  if (details.overlaps.length > 0 || details.omittedOverlapCount > 0) {
    lines.push("", "Overlaps (advisory; edits are not blocked):");
    for (const notice of details.overlaps) lines.push(...overlapLine(notice));
    if (details.omittedOverlapCount > 0) {
      lines.push(`- +${details.omittedOverlapCount} more overlaps omitted; inspect paths`);
    }
  }

  lines.push("", "Full transcripts: show_minion <id>");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function fleetChildState(node: AgentNode): FleetChildState {
  if (node.status === "pending") return "pending";
  if (node.activity?.phase === "settling") return "settling";
  return "running";
}

function toStillRunning(node: AgentNode, now: number): StillRunningChildPacket {
  const activity = node.activity ? projectTrustedActivity(node.activity) : undefined;
  return {
    childId: field(node.id) ?? "child",
    agent: field(namedAgent(node)),
    taskType: normalizeTaskType(node.taskType),
    description: field(node.description),
    state: fleetChildState(node),
    elapsedMs: Number.isFinite(now - node.startTime) ? Math.max(0, now - node.startTime) : 0,
    activity: boundedActivity(activity),
  };
}

function packetFits(details: LifecyclePacketDetails): boolean {
  return (
    Buffer.byteLength(JSON.stringify(details), "utf8") < PACKET_DETAILS_BYTE_BUDGET &&
    Buffer.byteLength(formatLifecyclePacket(details), "utf8") < PACKET_CONTENT_BYTE_BUDGET
  );
}

function addWhileFits<T>(
  details: LifecyclePacketDetails,
  target: T[],
  values: readonly T[],
  cap: number,
): void {
  for (const value of values.slice(0, cap)) {
    target.push(value);
    if (!packetFits(details)) {
      target.pop();
      break;
    }
  }
}

export class LifecyclePacketDispatcher {
  private queue: OwnedLifecycleEvent[] = [];
  private scheduled = false;
  private seq = 0;
  private closed = false;
  private readonly schedule: (run: () => void) => void;
  private readonly now: () => number;
  private readonly deliveredTerminals = new Map<string, string>();
  private deliveredTerminalOrder: string[] = [];

  constructor(private readonly deps: LifecyclePacketDispatcherDeps) {
    this.schedule = deps.schedule ?? queueMicrotask;
    this.now = deps.now ?? Date.now;
  }

  enqueue(event: OrchestrationLifecycleEvent): void {
    if (this.closed || !isPacketClass(event.class)) return;
    const registration = this.deps
      .getGroups()
      .getLifecycleRegistration(event.lifecycleId, event.groupId, event.epoch);
    const node = this.deps.getTree().get(event.childId);
    if (
      !registration ||
      registration.childId !== event.childId ||
      node?.kind !== "orchestrated" ||
      node.lifecycleId !== event.lifecycleId ||
      node.lifecycleEpoch !== event.epoch
    ) {
      return;
    }

    const terminalKey = event.class === "parentMessage" ? undefined : event.lifecycleId;
    if (terminalKey && this.deliveredTerminals.has(terminalKey)) return;
    this.queue.push({ event, registration, terminalKey });
    this.scheduleDrain();
  }

  reset(): void {
    this.queue = [];
    this.scheduled = false;
    this.seq = 0;
    this.deliveredTerminals.clear();
    this.deliveredTerminalOrder = [];
  }

  close(): void {
    this.closed = true;
    this.reset();
  }

  open(): void {
    this.closed = false;
    this.reset();
  }

  /** Cancellation is distinct from ack: queued/unaccepted evidence is forgotten. */
  discardGroup(groupId: string): void {
    this.queue = this.queue.filter((owned) => owned.event.groupId !== groupId);
    const kept: string[] = [];
    for (const key of this.deliveredTerminalOrder) {
      if (this.deliveredTerminals.get(key) === groupId) this.deliveredTerminals.delete(key);
      else kept.push(key);
    }
    this.deliveredTerminalOrder = kept;
  }

  inspectionCounts(): { queued: number; deliveredHistory: number } {
    return { queued: this.queue.length, deliveredHistory: this.deliveredTerminals.size };
  }

  private recordDelivered(key: string, groupId: string): void {
    if (this.deliveredTerminals.has(key)) return;
    this.deliveredTerminals.set(key, groupId);
    this.deliveredTerminalOrder.push(key);
    while (this.deliveredTerminalOrder.length > MAX_DELIVERED_TERMINAL_HISTORY) {
      const oldest = this.deliveredTerminalOrder.shift();
      if (oldest !== undefined) this.deliveredTerminals.delete(oldest);
    }
  }

  private scheduleDrain(recoverOnFailure = true): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      if (this.closed) {
        this.queue = [];
        return;
      }
      this.drain(recoverOnFailure);
    });
  }

  private drain(recoverOnFailure: boolean): void {
    const batch: OwnedLifecycleEvent[] = [];
    let packet: BuiltLifecyclePacket | undefined;
    do {
      batch.push(...this.queue.splice(0));
      packet = this.build(batch);
    } while (this.queue.length > 0);

    if (!packet) return;
    if (!this.submit(packet.details)) {
      this.queue.unshift(...batch);
      // One event-driven recovery submission handles a lone synchronous host failure.
      // A second failure preserves evidence for the next real lifecycle event.
      if (recoverOnFailure) this.scheduleDrain(false);
      return;
    }

    for (const registration of packet.terminalRegistrations) {
      this.recordDelivered(registration.lifecycleId, registration.groupId);
    }
    if (packet.idleReservation) {
      this.deps
        .getGroups()
        .acknowledgeIdleTransition(packet.idleReservation.groupId, packet.idleReservation.epoch);
    }
    for (const snapshot of packet.parentMailSnapshots) this.deps.ackParentMail?.(snapshot);
    this.deps.ackOverlaps?.(packet.overlapIds);
    // Accepted packet/evidence ack happens before exact-lifecycle cleanup. Replacement nodes survive.
    for (const registration of packet.terminalRegistrations) {
      this.deps.onAcceptedTerminal?.(registration);
    }
  }

  private build(events: OwnedLifecycleEvent[]): BuiltLifecyclePacket | undefined {
    const tree = this.deps.getTree();
    const groups = this.deps.getGroups();
    const now = this.now();
    const latest = new Map<string, OwnedLifecycleEvent>();
    const order: string[] = [];
    for (const owned of events) {
      const { event, registration } = owned;
      const currentRegistration = groups.getLifecycleRegistration(
        event.lifecycleId,
        event.groupId,
        event.epoch,
      );
      const node = tree.get(event.childId);
      if (
        !currentRegistration ||
        currentRegistration.childId !== registration.childId ||
        node?.lifecycleId !== event.lifecycleId ||
        node.lifecycleEpoch !== event.epoch ||
        (owned.terminalKey && this.deliveredTerminals.has(owned.terminalKey))
      ) {
        continue;
      }
      const category = event.class === "parentMessage" ? "mail" : "terminal";
      const key = `${event.lifecycleId}\u0000${category}`;
      if (!latest.has(key)) order.push(key);
      latest.set(key, owned);
    }
    const folded = order
      .map((key) => latest.get(key))
      .filter((event): event is OwnedLifecycleEvent => !!event);

    const allChanged: ChangedChildPacket[] = [];
    const terminalLifecycleIds = new Set<string>();
    const terminalGroupEpochs = new Map<string, Set<number>>();
    const terminalRegistrations = new Map<string, LifecycleRegistration>();
    const groupIds: string[] = [];
    const parentMailSnapshots: ParentMailSnapshot[] = [];

    for (const owned of folded) {
      const event = owned.event;
      if (!isPacketClass(event.class)) continue;
      const node = tree.get(event.childId);
      if (node?.kind !== "orchestrated") continue;
      if (!groupIds.includes(event.groupId)) groupIds.push(event.groupId);

      let output = event.output;
      if (event.class === "parentMessage" && this.deps.peekParentMail) {
        const snapshot = this.deps.peekParentMail(owned.registration);
        if (!snapshot || snapshot.ids.length === 0) continue;
        parentMailSnapshots.push(snapshot);
        output = snapshot.text;
      } else if (event.class !== "parentMessage") {
        terminalLifecycleIds.add(event.lifecycleId);
        const epochs = terminalGroupEpochs.get(event.groupId) ?? new Set<number>();
        epochs.add(event.epoch);
        terminalGroupEpochs.set(event.groupId, epochs);
        terminalRegistrations.set(event.lifecycleId, owned.registration);
      }

      const boundedOutput = boundText(output);
      const boundedError = boundText(event.error ?? node.error);
      allChanged.push({
        childId: field(node.id) ?? "child",
        displayName: field(node.name) ?? "child",
        agent: field(namedAgent(node)),
        taskType: normalizeTaskType(node.taskType),
        description: field(node.description),
        domain: boundedDomain(node.domain),
        eventClass: event.class,
        output: boundedOutput?.text,
        outputTruncated: boundedOutput?.truncated || undefined,
        error: boundedError?.text,
        errorTruncated: boundedError?.truncated || undefined,
        nudge:
          field(
            nudgeFor(
              { taskType: node.taskType, completionNudge: node.completionNudge },
              event.class,
            ),
            PACKET_NUDGE_CHAR_CAP,
          ) ?? FALLBACK_NUDGE,
      });
      if (event.class === "parentMessage") {
        const changed = allChanged.at(-1);
        logger.info("packets", "parent-message", {
          childId: changed?.childId,
          eventClass: event.class,
          stillRunning: true,
          nudgeExcerpt: changed?.nudge.slice(0, 80),
        });
      }
    }
    if (allChanged.length === 0) return undefined;

    const seen = new Set<string>();
    const allStillRunning: StillRunningChildPacket[] = [];
    for (const groupId of groupIds) {
      const members = [...tree.getOrchestratedGroup(groupId)].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      for (const node of members) {
        if (node.lifecycleId && terminalLifecycleIds.has(node.lifecycleId)) continue;
        const identity = node.lifecycleId ?? node.id;
        if (seen.has(identity)) continue;
        seen.add(identity);
        allStillRunning.push(toStillRunning(node, now));
      }
    }

    let groupIdleId: string | undefined;
    let idleReservation: IdleReservation | undefined;
    for (const [groupId, epochs] of terminalGroupEpochs) {
      const hasLiveWork = tree.getOrchestratedGroup(groupId).length > 0;
      const epoch = groups.peekIdleTransition(groupId, hasLiveWork, epochs);
      if (epoch !== undefined) {
        groupIdleId = field(groupId) ?? "group";
        idleReservation = { groupId, epoch };
        break;
      }
    }

    const overlapSnapshot = this.deps.peekOverlaps?.(groupIds) ?? { ids: [], notices: [] };
    const allOverlaps = overlapSnapshot.notices.map(boundedOverlap);
    const details: LifecyclePacketDetails = {
      seq: this.seq + 1,
      groupIds: groupIds.slice(0, MAX_CHANGED_CHILDREN).map((id) => field(id) ?? "group"),
      changed: [],
      stillRunning: [],
      changedCount: allChanged.length,
      stillRunningCount: allStillRunning.length,
      groupIdleId,
      overlaps: [],
      omittedOverlapCount: allOverlaps.length,
    };

    // Stable aggregate priority: semantic envelope/counts/state/idle, identities/activity/path,
    // then terminal output/error/specific nudge. Every mutation is checked against both budgets.
    const changedBase = allChanged.map((child) => ({
      childId: child.childId,
      displayName: child.displayName,
      agent: child.agent,
      taskType: child.taskType,
      description: child.description,
      domain: child.domain,
      eventClass: child.eventClass,
      nudge: FALLBACK_NUDGE,
    }));
    addWhileFits(details, details.changed, changedBase, MAX_CHANGED_CHILDREN);
    addWhileFits(details, details.stillRunning, allStillRunning, MAX_STILL_RUNNING_CHILDREN);
    for (const overlap of allOverlaps.slice(0, MAX_PACKET_OVERLAPS)) {
      details.overlaps.push(overlap);
      details.omittedOverlapCount = allOverlaps.length - details.overlaps.length;
      if (!packetFits(details)) {
        details.overlaps.pop();
        details.omittedOverlapCount = allOverlaps.length - details.overlaps.length;
        break;
      }
    }

    for (let index = 0; index < details.changed.length; index++) {
      const projected = details.changed[index];
      const source = allChanged[index];
      if (!projected || !source) continue;
      for (const key of [
        "output",
        "outputTruncated",
        "error",
        "errorTruncated",
        "nudge",
      ] as const) {
        const prior = projected[key] as never;
        Object.assign(projected, { [key]: source[key] });
        if (!packetFits(details)) Object.assign(projected, { [key]: prior });
      }
    }

    if (!packetFits(details)) {
      // The fixed envelope is intentionally tiny; this is a defensive impossible-state guard.
      logger.error("packets", "packet-envelope-exceeds-budget", { seq: details.seq });
      return undefined;
    }
    return {
      details,
      terminalRegistrations: [...terminalRegistrations.values()],
      idleReservation,
      parentMailSnapshots,
      overlapIds: overlapSnapshot.ids,
    };
  }

  private submit(packet: LifecyclePacketDetails): boolean {
    const content = formatLifecyclePacket(packet);
    const byteSize = Buffer.byteLength(content, "utf8");
    logger.info("packets", "submit", {
      seq: packet.seq,
      childIds: packet.changed.map((child) => child.childId),
      eventClasses: packet.changed.map((child) => child.eventClass),
      fleetIds: packet.stillRunning.map((child) => child.childId),
      groupIdleId: packet.groupIdleId,
      byteSize,
      detailsByteSize: Buffer.byteLength(JSON.stringify(packet), "utf8"),
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
      this.seq = packet.seq;
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error("packets", "submit-failed", { seq: packet.seq, error });
      return false;
    }
  }
}

export function createLifecyclePacketDispatcher(
  deps: LifecyclePacketDispatcherDeps,
): LifecyclePacketDispatcher {
  return new LifecyclePacketDispatcher(deps);
}
