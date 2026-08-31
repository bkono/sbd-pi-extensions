import { logger } from "../logger.js";
import { type AgentTree, isTerminalStatus } from "../tree.js";
import type { PathIntent } from "../types.js";
import { normalizeIntentPath, pathsOverlap } from "./paths.js";

/** Mailbox shape used for overlap notices. 3.2 owns live delivery. */
export interface PathIntentMailbox {
  enqueue(input: {
    from: string;
    to: string;
    groupId: string;
    body: string;
    lifecycleId: string;
    lifecycleEpoch: number;
  }): unknown;
}

export interface PathOverlapNotice {
  groupId: string;
  childId: string;
  /** Immutable owner evidence; never recover from childId later. */
  lifecycleId: string;
  epoch: number;
  childDescription?: string;
  path: string;
  otherId: string;
  otherDescription?: string;
  otherPath: string;
  editAllowed: true;
}

export interface PathOverlapSnapshot {
  ids: string[];
  notices: PathOverlapNotice[];
}

export interface AnnouncePathIntentInput {
  tree: AgentTree;
  groups: {
    ownsLifecycle(authority: {
      groupId: string;
      childId: string;
      lifecycleId: string;
      epoch: number;
    }): boolean;
  };
  childId: string;
  lifecycleId: string;
  epoch: number;
  groupId: string;
  cwd: string;
  paths: readonly string[];
  ttlMs: number;
  note?: string;
  now: number;
  overlaps?: PathOverlapLog;
  mailbox?: PathIntentMailbox;
}

export interface PathOverlapHit {
  otherId: string;
  otherDescription?: string;
  path: string;
  otherPath: string;
}

export interface AnnouncePathIntentResult {
  childId: string;
  groupId: string;
  paths: string[];
  ttlMs: number;
  announcedAt: number;
  overlaps: PathOverlapHit[];
  overlap: boolean;
  editAllowed: true;
}

export interface InspectedPathIntent {
  childId: string;
  description?: string;
  path: string;
  ttlMs?: number;
  announcedAt?: number;
  overlapping: boolean;
}

export interface InspectPathIntentResult {
  groupId: string;
  intents: InspectedPathIntent[];
}

/**
 * Pending overlap metadata for the next real parent packet.
 * Recording here never starts a parent turn.
 */
export class PathOverlapLog {
  private pending: Array<{ id: string; notice: PathOverlapNotice }> = [];
  private nextId = 0;
  static readonly MAX_PENDING = 256;

  record(notice: PathOverlapNotice): void {
    this.nextId++;
    this.pending.push({ id: `overlap-${this.nextId.toString(36)}`, notice });
    if (this.pending.length > PathOverlapLog.MAX_PENDING) this.pending.shift();
  }

  peek(groupIds?: readonly string[]): PathOverlapSnapshot {
    const wanted = groupIds === undefined ? undefined : new Set(groupIds);
    const entries = this.pending.filter(
      (entry) => wanted === undefined || wanted.has(entry.notice.groupId),
    );
    return {
      ids: entries.map((entry) => entry.id),
      notices: entries.map((entry) => ({ ...entry.notice })),
    };
  }

  ack(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const wanted = new Set(ids);
    const rest = this.pending.filter((entry) => !wanted.has(entry.id));
    const removed = this.pending.length - rest.length;
    this.pending = rest;
    return removed;
  }

  consume(groupIds?: readonly string[]): PathOverlapNotice[] {
    const snapshot = this.peek(groupIds);
    this.ack(snapshot.ids);
    return snapshot.notices;
  }

  discardLifecycle(input: {
    groupId: string;
    childId: string;
    lifecycleId: string;
    epoch: number;
  }): number {
    const before = this.pending.length;
    this.pending = this.pending.filter(
      (entry) =>
        !(
          entry.notice.groupId === input.groupId &&
          entry.notice.childId === input.childId &&
          entry.notice.lifecycleId === input.lifecycleId &&
          entry.notice.epoch === input.epoch
        ),
    );
    return before - this.pending.length;
  }

  discardGroup(groupId: string): number {
    const before = this.pending.length;
    this.pending = this.pending.filter((entry) => entry.notice.groupId !== groupId);
    return before - this.pending.length;
  }

  list(): readonly PathOverlapNotice[] {
    return this.pending.map((entry) => entry.notice);
  }
}

export function isExpiredIntent(intent: PathIntent, now: number): boolean {
  if (intent.ttlMs === undefined || intent.announcedAt === undefined) return false;
  return now >= intent.announcedAt + intent.ttlMs;
}

export function activeIntents(intents: PathIntent[] | undefined, now: number): PathIntent[] {
  return (intents ?? []).filter((intent) => !isExpiredIntent(intent, now));
}

function uniqueNormalized(paths: readonly string[], cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const normalized = normalizeIntentPath(typeof raw === "string" ? raw : "", cwd);
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function pruneExpired(tree: AgentTree, childId: string, now: number): PathIntent[] {
  const node = tree.get(childId);
  const live = activeIntents(node?.pathIntent, now);
  if (node && (node.pathIntent?.length ?? 0) !== live.length) {
    tree.updateInspection(childId, { pathIntent: live });
  }
  return live;
}

function formatOverlapBody(notice: PathOverlapNotice): string {
  const who = notice.childDescription
    ? `${notice.childId} (${notice.childDescription})`
    : notice.childId;
  return (
    `Path overlap (advisory; edits are not blocked): ${who} announced ${notice.path} ` +
    `which overlaps your ${notice.otherPath}. Message them with send_minion_peer to coordinate. ` +
    "Expired intent does not mean they stopped."
  );
}

/**
 * Store advisory intent and notify overlapping live peers. Never locks, pauses,
 * or rejects writes. Spawn / other groups / terminal children are ignored.
 */
export function announcePathIntent(input: AnnouncePathIntentInput): AnnouncePathIntentResult {
  const { tree, groups, childId, lifecycleId, epoch, groupId, cwd, ttlMs, note, now } = input;
  const paths = uniqueNormalized(input.paths, cwd);
  const announced: PathIntent[] = paths.map((path) => ({
    path,
    ttlMs,
    announcedAt: now,
    ...(note !== undefined ? { note } : {}),
  }));

  const ownsLifecycle = groups.ownsLifecycle({ groupId, childId, lifecycleId, epoch });
  const node = tree.get(childId);
  if (
    node?.kind === "orchestrated" &&
    node.groupId === groupId &&
    node.lifecycleId === lifecycleId &&
    node.lifecycleEpoch === epoch &&
    !isTerminalStatus(node.status) &&
    ownsLifecycle
  ) {
    tree.updateInspection(childId, { pathIntent: announced });
  }

  const overlaps: PathOverlapHit[] = [];
  if (
    node?.kind === "orchestrated" &&
    node.groupId === groupId &&
    node.lifecycleId === lifecycleId &&
    node.lifecycleEpoch === epoch &&
    !isTerminalStatus(node.status) &&
    ownsLifecycle
  ) {
    for (const peer of tree.getOrchestratedGroup(groupId)) {
      if (peer.id === childId) continue;
      const peerIntents = pruneExpired(tree, peer.id, now);
      for (const announcedPath of paths) {
        for (const peerIntent of peerIntents) {
          if (!pathsOverlap(announcedPath, peerIntent.path)) continue;
          overlaps.push({
            otherId: peer.id,
            otherDescription: peer.description,
            path: announcedPath,
            otherPath: peerIntent.path,
          });
        }
      }
    }
  }

  const uniqueHits: PathOverlapHit[] = [];
  const seenHits = new Set<string>();
  for (const hit of overlaps) {
    const key = `${hit.otherId}\0${hit.path}\0${hit.otherPath}`;
    if (seenHits.has(key)) continue;
    seenHits.add(key);
    uniqueHits.push(hit);
  }

  const noticesByPeer = new Map<string, PathOverlapNotice[]>();

  for (const hit of uniqueHits) {
    const notice: PathOverlapNotice = {
      groupId,
      childId,
      lifecycleId,
      epoch,
      childDescription: node?.description,
      path: hit.path,
      otherId: hit.otherId,
      otherDescription: hit.otherDescription,
      otherPath: hit.otherPath,
      editAllowed: true,
    };
    input.overlaps?.record(notice);
    const peerNotices = noticesByPeer.get(hit.otherId);
    if (peerNotices) peerNotices.push(notice);
    else noticesByPeer.set(hit.otherId, [notice]);
    logger.info("path-intent", "overlap", {
      paths: [hit.path, hit.otherPath],
      childId,
      otherId: hit.otherId,
      overlap: true,
      editAllowed: true,
    });
  }

  for (const [peerId, notices] of noticesByPeer) {
    const first = notices[0];
    if (!first) continue;
    const additional = notices.length > 1 ? ` ${notices.length - 1} additional overlap(s).` : "";
    input.mailbox?.enqueue({
      from: childId,
      to: peerId,
      groupId,
      lifecycleId,
      lifecycleEpoch: epoch,
      body: `${formatOverlapBody(first)}${additional}`,
    });
  }

  logger.info("path-intent", "announce", {
    paths,
    childId,
    groupId,
    overlap: uniqueHits.length > 0,
    editAllowed: true,
  });

  return {
    childId,
    groupId,
    paths,
    ttlMs,
    announcedAt: now,
    overlaps: uniqueHits,
    overlap: uniqueHits.length > 0,
    editAllowed: true,
  };
}

export function inspectPathIntent(input: {
  tree: AgentTree;
  groupId: string;
  now: number;
}): InspectPathIntentResult {
  const liveNodes = input.tree.getOrchestratedGroup(input.groupId);
  const collected: InspectedPathIntent[] = [];
  for (const node of liveNodes) {
    const intents = pruneExpired(input.tree, node.id, input.now);
    for (const intent of intents) {
      collected.push({
        childId: node.id,
        description: node.description,
        path: intent.path,
        ttlMs: intent.ttlMs,
        announcedAt: intent.announcedAt,
        overlapping: false,
      });
    }
  }

  for (const entry of collected) {
    entry.overlapping = collected.some(
      (other) => other.childId !== entry.childId && pathsOverlap(entry.path, other.path),
    );
  }

  logger.info("path-intent", "inspect", {
    groupId: input.groupId,
    paths: collected.map((entry) => entry.path),
    childIds: [...new Set(collected.map((entry) => entry.childId))],
    overlap: collected.some((entry) => entry.overlapping),
    editAllowed: true,
  });

  return { groupId: input.groupId, intents: collected };
}

export function formatAnnounceResult(result: AnnouncePathIntentResult): string {
  const listed = result.paths.length > 0 ? result.paths.join(", ") : "(none)";
  const lines = [`Announced ${result.paths.length} path(s) (ttl=${result.ttlMs}ms): ${listed}`];
  if (result.overlap) {
    for (const hit of result.overlaps) {
      const who = hit.otherDescription ? `${hit.otherId} (${hit.otherDescription})` : hit.otherId;
      lines.push(
        `Overlap with ${who} on ${hit.path} vs ${hit.otherPath}. ` +
          "Advisory only; edits are not blocked. Message them with send_minion_peer to coordinate.",
      );
    }
  } else {
    lines.push("No overlap. Advisory only; expiry does not mean you stopped touching the path.");
  }
  return lines.join("\n");
}

export function formatInspectResult(result: InspectPathIntentResult): string {
  if (result.intents.length === 0) {
    return `No active path intent in group ${result.groupId}. Expired intent does not mean an agent stopped.`;
  }
  const lines = [`Path intent in group ${result.groupId}:`];
  for (const intent of result.intents) {
    const who = intent.description ? `${intent.childId} (${intent.description})` : intent.childId;
    const ttl = intent.ttlMs !== undefined ? ` ttl=${intent.ttlMs}ms` : "";
    const overlap = intent.overlapping ? " overlap=true" : " overlap=false";
    lines.push(`- ${who}: ${intent.path}${ttl}${overlap}`);
  }
  lines.push("Advisory only; edits are not blocked.");
  return lines.join("\n");
}
