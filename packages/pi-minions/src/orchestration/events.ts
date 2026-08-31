/**
 * Orchestrated-child lifecycle events for coalesced parent packets (1.8).
 *
 * `started` means startChild returned a handle. Packet classes are
 * settled | aborted | failed | parentMessage; 1.8 ignores `started`.
 * Start failure (startChild throws) is `failed` so it does not become an
 * unhandled rejection and is still visible to 1.8.
 * `parentMessage` is a live child → parent question (3.3). The child stays running.
 */
export const ORCHESTRATION_LIFECYCLE_CHANNEL = "orchestration:lifecycle";

let nextLifecycleInstance = 0;

/** Process-unique opaque runtime registration identity. Public child ids remain unchanged. */
export function createLifecycleId(): string {
  nextLifecycleInstance++;
  return `lifecycle-${nextLifecycleInstance.toString(36)}`;
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
