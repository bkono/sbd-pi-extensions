import type { ContextHygieneMasks } from "./context-application.js";
import type { ContextHygieneRetiredRecord, ContextHygieneStaleRecord } from "./context-hygiene.js";

/**
 * `pi.events` channel for the cached-prompt-prefix contract. An extension that owns when
 * the request prefix may change (pi-om, whose edits land only with an activation or
 * reflection) emits one {@link PrefixSignal} per provider request from its `context`
 * handler. pi-om declares the same literal; both sides test it.
 */
export const PREFIX_SIGNAL_CHANNEL = "context:prefix";

export interface PrefixSignal {
  source: string;
  /** This request's cached prefix cannot be reused anyway (activation, compaction, ...). */
  moved: boolean;
}

export function isPrefixSignal(value: unknown): value is PrefixSignal {
  if (!value || typeof value !== "object") return false;
  const signal = value as Partial<PrefixSignal>;
  return typeof signal.source === "string" && typeof signal.moved === "boolean";
}

/**
 * Decides, per provider request, which stale and retired masks the request carries.
 *
 * Masking a result the provider already saw rewrites an item inside the cached prefix and
 * forfeits the cache from there on. Without a prefix owner every mask lands at once (the
 * standalone behavior). With one, a mask on an already-sent result waits for a request
 * whose prefix moves anyway; a result the provider has not seen is masked right away.
 * A landed mask is frozen, so its bytes never change on a later request.
 */
export class StaleMaskGate {
  private signal: PrefixSignal | undefined;
  private readonly stale = new Map<string, ContextHygieneStaleRecord>();
  private readonly retired = new Map<string, ContextHygieneRetiredRecord>();
  /** Tool result ids the previous request carried, i.e. the cached ones. */
  private sent = new Set<string>();

  observe(value: unknown): void {
    if (!isPrefixSignal(value)) return;
    this.signal = { source: value.source, moved: value.moved || this.signal?.moved === true };
  }

  /** Call once per provider request with every mask the tracker currently calls for. */
  next(
    desired: ContextHygieneMasks,
    messages: readonly { role?: unknown; toolCallId?: unknown }[],
  ): ContextHygieneMasks {
    const release = this.signal === undefined || this.signal.moved;
    for (const [id, record] of desired.stale) {
      if (!this.stale.has(id) && (release || !this.sent.has(id))) this.stale.set(id, record);
    }
    for (const [id, record] of desired.retired) {
      if (!this.retired.has(id) && (release || !this.sent.has(id))) this.retired.set(id, record);
    }
    this.signal = undefined;
    this.sent = new Set(
      messages
        .filter((m) => m.role === "toolResult" && typeof m.toolCallId === "string")
        .map((m) => m.toolCallId as string),
    );
    return { stale: this.stale, retired: this.retired };
  }
}
