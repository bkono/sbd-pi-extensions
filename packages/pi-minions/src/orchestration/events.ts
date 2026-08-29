/**
 * Orchestrated-child lifecycle events for coalesced parent packets (1.8).
 *
 * `started` means startChild returned a handle. Packet classes are
 * settled | aborted | failed | parentMessage; 1.8 ignores `started`.
 * Start failure (startChild throws) is `failed` so it does not become an
 * unhandled rejection and is still visible to 1.8.
 */
export const ORCHESTRATION_LIFECYCLE_CHANNEL = "orchestration:lifecycle";

export type OrchestrationLifecycleClass = "started" | "settled" | "aborted" | "failed";

export interface OrchestrationLifecycleEvent {
  class: OrchestrationLifecycleClass;
  groupId: string;
  childId: string;
  error?: string;
}
