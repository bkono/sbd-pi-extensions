/**
 * Orchestrated-child lifecycle events for coalesced parent packets (1.8).
 *
 * `started` means startChild returned a handle. Packet classes are
 * settled | aborted | failed | parentMessage; 1.8 ignores `started`.
 * Start failure (startChild throws) is `failed` so it does not become an
 * unhandled rejection and is still visible to 1.8.
 * `parentMessage` is a live child → parent notification (3.3). It does not hold the child live.
 */
export const ORCHESTRATION_LIFECYCLE_CHANNEL = "orchestration:lifecycle";

/**
 * Reload-safe opaque runtime registration identity. `crypto.randomUUID()` is provided by the
 * host runtime rather than module state, so Jiti `moduleCache:false` reloads cannot reset it.
 */
export function createLifecycleId(): string {
  return crypto.randomUUID();
}

export type OrchestrationLifecycleClass =
  | "started"
  | "settled"
  | "aborted"
  | "failed"
  | "parentMessage";

export interface OrchestrationLifecycleEvent {
  class: OrchestrationLifecycleClass;
  groupId: string;
  childId: string;
  /** Immutable identity of this accepted child runtime, independent of display childId. */
  lifecycleId: string;
  /** Idle epoch captured when this runtime registration was accepted. */
  epoch: number;
  error?: string;
  /** Bounded by the packet layer. Full text remains on the child transcript. */
  output?: string;
}
