import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Other extensions extend minions over `pi.events`, without importing this package.
 *
 * Handshake: minions emits READY with its API when it loads and whenever it hears HELLO. A
 * contributor emits HELLO when it loads, and on READY emits CONTRIBUTE. Either load order works.
 * A contribution replaces the previous one from the same `source`.
 */
export const MINIONS_HELLO_EVENT = "pi-minions:hello";
export const MINIONS_READY_EVENT = "pi-minions:ready";
export const MINIONS_CONTRIBUTE_EVENT = "pi-minions:contribute";

export interface MinionsContribution {
  /** Stable contributor id, e.g. the package name. */
  source: string;
  /** Agent directories, discovered above built-ins and below user and project agents. */
  agentDirs?: string[];
  /** Tools injected only into children of the named agent. */
  agentTools?: Record<string, ToolDefinition[]>;
  /** Tool names never active in any child session. */
  parentOnlyTools?: string[];
}

export interface MinionsReadyApi {
  /** Orchestrated children that have not reached a terminal status. */
  liveOrchestrated(): number;
}

const contributions = new Map<string, MinionsContribution>();

function isContribution(value: unknown): value is MinionsContribution {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { source?: unknown }).source === "string" &&
    (value as { source: string }).source.length > 0
  );
}

export function setContribution(contribution: MinionsContribution): void {
  contributions.set(contribution.source, contribution);
}

/** Test seam. */
export function clearContributions(): void {
  contributions.clear();
}

export function contributedAgentDirs(): string[] {
  return [...contributions.values()].flatMap((c) => c.agentDirs ?? []);
}

export function contributedToolsFor(agent: string | undefined): ToolDefinition[] {
  if (!agent) return [];
  return [...contributions.values()].flatMap((c) => c.agentTools?.[agent] ?? []);
}

export function contributedParentOnlyTools(): ReadonlySet<string> {
  return new Set([...contributions.values()].flatMap((c) => c.parentOnlyTools ?? []));
}

export function connectContributions(pi: Pick<ExtensionAPI, "events">, api: MinionsReadyApi): void {
  pi.events.on(MINIONS_CONTRIBUTE_EVENT, (data: unknown) => {
    if (isContribution(data)) setContribution(data);
  });
  pi.events.on(MINIONS_HELLO_EVENT, () => {
    pi.events.emit(MINIONS_READY_EVENT, api);
  });
  pi.events.emit(MINIONS_READY_EVENT, api);
}
