import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ProjectedSessionEntry,
  SessionBoundaryDraft,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { ResolvedOMConfig } from "./config.js";
import { buildOMSection, CONTINUATION_REMINDER, OM_SECTION } from "./context.js";
import {
  activatableChunks,
  type ContextUnit,
  computeStatus,
  decideReflection,
  describeUnit,
  type OMStatus,
  selectActivationCount,
  selectReflectionSlice,
  selectSafePrefix,
  shouldBuffer,
} from "./engine.js";
import { type ModelAccess, resolveModelCandidates } from "./models.js";
import { observe } from "./observer.js";
import { reflect } from "./reflector.js";
import {
  type ActivationTrigger,
  type ChunkData,
  hasActiveMemory,
  OM_ACTIVATION,
  OM_CHUNK,
  OM_REFLECTION,
  type OMEntryDraft,
  type OMState,
  type ReflectionData,
  renderActiveObservations,
  replayState,
} from "./state.js";
import { MessageTokenCache } from "./tokens.js";
import { temporalGapText } from "./transcript.js";
import { resolveActivationTTL } from "./upstream/activation-ttl";
import { wrapInObservationGroup } from "./upstream/observation-groups";

/** What the runtime needs from Pi for one hook invocation. */
export interface Host {
  registry: ModelAccess;
  model: Model<Api> | undefined;
  branch(): SessionEntry[];
  projection(): ProjectedSessionEntry[];
  isIdle(): boolean;
  appendEntry(customType: string, data: unknown): void;
  setStatus(text: string | undefined): void;
  getSessionName?(): string | undefined;
  setSessionName?(name: string): void;
  now(): number;
  env?: NodeJS.ProcessEnv;
}

export type OMEventKind =
  | "context"
  | "turn_end"
  | "settle"
  | "buffer"
  | "activate"
  | "block"
  | "reflect-buffer"
  | "reflect-activate"
  | "reflect-sync"
  | "compaction"
  | "tree"
  | "dropped"
  | "failover"
  | "error";

export interface OMEvent {
  kind: OMEventKind;
  at: number;
  ms?: number;
  detail?: string;
}

/** A buffered reflection waiting for the threshold, with the state it was computed from. */
interface BufferedReflection {
  baseReflectionId?: string;
  chunkIds: string[];
  inputTokens: number;
  observations: string;
  observationTokens: number;
  currentTask?: string;
  suggestedResponse?: string;
  model: string;
}

type BackoffKind = "buffer" | "block" | "reflect";

const MAX_EVENTS = 200;
const BLOCKING_BATCH_FACTOR = 2;
const BLOCKING_CONCURRENCY = 4;
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

function newId(): string {
  return randomBytes(8).toString("hex");
}

function messageKey(message: AgentMessage): string {
  const m = message as {
    role?: string;
    timestamp?: number;
    toolCallId?: string;
    responseId?: string;
    customType?: string;
  };
  return `${m.role}|${m.timestamp}|${m.toolCallId ?? ""}|${m.responseId ?? ""}|${m.customType ?? ""}`;
}

/**
 * Mastra temporalMarkers, derived instead of persisted: for every user message that follows
 * a gap of 10 minutes or more in the branch's full history, the reminder text. Deterministic
 * from timestamps, so the request prefix stays cache-stable and pruning a predecessor never
 * fakes a gap.
 */
function temporalGaps(branch: readonly SessionEntry[]): Map<string, string> {
  const gaps = new Map<string, string>();
  let previous: AgentMessage | undefined;
  for (const entry of branch) {
    if (entry.type !== "message" && entry.type !== "custom_message") continue;
    const message =
      entry.type === "message"
        ? (entry.message as AgentMessage)
        : ({ role: "custom", timestamp: Date.parse(entry.timestamp) } as AgentMessage);
    const gap = temporalGapText(previous, message);
    if (gap) gaps.set(entry.id, gap);
    previous = message;
  }
  return gaps;
}

/**
 * The user message that started the current (or last) run. It stays raw in context while
 * newer work happens, even once observed: with it pruned mid-task the model only has the
 * continuation hint ("respond to the latest message") and a tool result, and it stops.
 * Measured in a live A/B: both this port and Mastra Code stopped right after activation
 * on a 43-step task that completes with OM off.
 */
export function protectedRequestId(entries: readonly ProjectedSessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.messages.some((message) => (message as { role?: string }).role === "user")) {
      return entry.sourceEntry.id;
    }
  }
  return undefined;
}

function formatK(tokens: number): string {
  return tokens < 1_000 ? `${tokens}` : `${(tokens / 1_000).toFixed(1)}k`;
}

async function withTimeout<T>(promise: Promise<T> | undefined, ms: number): Promise<void> {
  if (!promise) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/**
 * Observational memory for one Pi session. Mirrors Mastra's per-step pipeline:
 * background buffering on 6k intervals, non-blocking activation between the threshold and
 * blockAfter, cache-TTL and provider-change activation at run start, buffered reflection,
 * and a single blocking path at blockAfter.
 *
 * Model availability only gates new observer and reflector work. Memory that already
 * exists keeps being injected, because its raw messages are already omitted by context edits.
 */
export class SessionOM {
  private pending: OMEntryDraft[] = [];
  private readonly pendingEdits = new Set<string>();
  private readonly tokens = new MessageTokenCache();
  private bufferOp: Promise<void> | undefined;
  private reflectionOp: Promise<void> | undefined;
  private bufferedReflection: BufferedReflection | undefined;
  private firstRequestOfRun = true;
  /** Bumps on `/tree`; background results started in an older epoch are dropped. */
  private epoch = 0;
  private readonly abort = new AbortController();
  private disposed = false;
  private lastHost: Host | undefined;
  private lastError: string | undefined;
  private lastFailover: string | undefined;
  private blocking: string | undefined;
  private sectionCache: { key: string; section: string | undefined } | undefined;
  private readonly backoff = new Map<BackoffKind, { until: number; ms: number }>();
  readonly events: OMEvent[] = [];

  constructor(
    readonly sessionId: string,
    private readonly config: ResolvedOMConfig,
  ) {}

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
  }

  /** Background work, for tests and shutdown. */
  async settled(): Promise<void> {
    while (this.bufferOp || this.reflectionOp) {
      await Promise.allSettled([this.bufferOp, this.reflectionOp]);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle hooks
  // ---------------------------------------------------------------------------

  startRun(_host: Host): void {
    this.firstRequestOfRun = true;
  }

  /** `/tree` moved the leaf: uncommitted work and buffered results belong to the old branch. */
  onTreeChange(host: Host): void {
    this.epoch += 1;
    this.pending = [];
    this.pendingEdits.clear();
    this.bufferedReflection = undefined;
    this.sectionCache = undefined;
    this.firstRequestOfRun = true;
    this.record("tree", host.now(), host);
    this.refreshStatus();
  }

  /** `context`: run-start activation and reflection (Mastra step 0). Never edits messages. */
  async onContext(host: Host): Promise<void> {
    if (this.disposed) return;
    this.lastHost = host;
    if (!this.firstRequestOfRun) return;
    this.firstRequestOfRun = false;
    const startedAt = host.now();
    await this.prepareRunStart(host.projection(), host, this.models(host));
    this.record("context", startedAt, host, "run start");
  }

  /**
   * `context_with_system`: owns the full transcript, so request-local omission, the
   * continuation reminder and the OM section never collapse Pi's mid-transcript system
   * messages the way a `context` result does.
   */
  onSystem(messages: AgentMessage[], host: Host): AgentMessage[] | undefined {
    if (this.disposed) return undefined;
    this.lastHost = host;
    const lead = messages[0] as
      | { role?: string; sections?: Record<string, string | null> }
      | undefined;
    if (!lead || lead.role !== "system") return undefined;
    const projection = host.projection();
    const state = this.state(host);

    // Omit observed entries whose context edits are not committed yet.
    const idsByKey = new Map<string, string[]>();
    for (const entry of projection) {
      for (const message of entry.messages) {
        const key = messageKey(message);
        const ids = idsByKey.get(key);
        if (ids) ids.push(entry.sourceEntry.id);
        else idsByKey.set(key, [entry.sourceEntry.id]);
      }
    }
    const gaps = temporalGaps(host.branch());
    const keepRaw = protectedRequestId(projection);
    let omitted = 0;
    let markers = 0;
    const rest: AgentMessage[] = [];
    for (const message of messages.slice(1)) {
      if ((message as { role?: string }).role !== "system") {
        const entryId = idsByKey.get(messageKey(message))?.shift();
        if (entryId && entryId !== keepRaw && state.observedEntryIds.has(entryId)) {
          omitted += 1;
          continue;
        }
        const gap = entryId ? gaps.get(entryId) : undefined;
        if (gap) {
          markers += 1;
          rest.push({
            role: "user",
            content: `<system-reminder>${gap}</system-reminder>`,
            timestamp: ((message as { timestamp?: number }).timestamp ?? 1) - 1,
          } as AgentMessage);
        }
      }
      rest.push(message);
    }

    const section = this.section(state, host);
    const memory = hasActiveMemory(state);
    this.updateStatus(host, projection, state);
    if (
      !memory &&
      omitted === 0 &&
      markers === 0 &&
      section === undefined &&
      lead.sections?.[OM_SECTION] === undefined
    ) {
      return undefined;
    }
    const sections = { ...(lead.sections ?? {}) };
    if (section === undefined) delete sections[OM_SECTION];
    else sections[OM_SECTION] = section;
    const reminder = memory
      ? [{ role: "user", content: CONTINUATION_REMINDER, timestamp: 0 } as AgentMessage]
      : [];
    return [{ ...(messages[0] as object), sections } as AgentMessage, ...reminder, ...rest];
  }

  /** `turn_end`: buffer, activate in band, block only at blockAfter, reflect, commit. */
  async onTurnEnd(
    input: { contextEntries: ProjectedSessionEntry[] },
    host: Host,
  ): Promise<SessionBoundaryDraft[]> {
    if (this.disposed) return [];
    this.lastHost = host;
    const startedAt = host.now();
    const candidates = this.models(host);

    let state = this.state(host);
    const units = this.units(input.contextEntries);
    let status = computeStatus(units, state, this.config);

    // Mastra: in the threshold→blockAfter band with a chunk ready, activate instead of buffering.
    const activateBeforeBuffering = status.inBand && status.canActivate;
    if (!activateBeforeBuffering) this.maybeStartBuffer(status, state, host, candidates);

    if (status.shouldObserve && status.canActivate) {
      this.activate(state, units, status.pendingTokens, "threshold", host);
      state = this.state(host);
      status = computeStatus(units, state, this.config);
    }

    if (status.mustBlock && !this.backedOff("block", host)) {
      await this.blockingObserve(input.contextEntries, host, candidates, "block");
      status = computeStatus(units, this.state(host), this.config);
    }

    await this.maybeReflect(host, candidates);
    this.updateStatus(host, input.contextEntries, this.state(host));
    this.record("turn_end", startedAt, host, `pending ${formatK(status.pendingTokens)}`);
    return this.flushDrafts(input.contextEntries, host);
  }

  /** `agent_before_settle`: commit what is pending and keep buffering while idle. */
  onSettle(input: { contextEntries: ProjectedSessionEntry[] }, host: Host): SessionBoundaryDraft[] {
    if (this.disposed) return [];
    this.lastHost = host;
    const startedAt = host.now();
    const state = this.state(host);
    const status = computeStatus(this.units(input.contextEntries), state, this.config);
    this.maybeStartBuffer(status, state, host, this.models(host));
    this.updateStatus(host, input.contextEntries, state);
    this.record("settle", startedAt, host);
    return this.flushDrafts(input.contextEntries, host);
  }

  /**
   * `session_before_compact`: bring memory up to date and replace Pi's summarizer.
   * Activations stay pending until `session_compact` confirms the compaction (or the next
   * boundary commits them with their edits), so a cancelled compaction leaves no
   * activation without edits.
   */
  async onCompact(
    host: Host,
    signal?: AbortSignal,
  ): Promise<{ firstKeptEntryId: string; summary: string } | undefined> {
    if (this.disposed) return undefined;
    this.lastHost = host;
    const startedAt = host.now();
    const projection = host.projection();
    await this.blockingObserve(projection, host, this.models(host), "compaction", signal);
    if (signal?.aborted) return undefined;
    this.appendPending(host, { includeActivations: false });
    const state = this.state(host);
    if (!hasActiveMemory(state)) return undefined;
    const units = this.units(projection);
    const firstUnobserved = units.find(
      (unit) => unit.observable && !state.observedEntryIds.has(unit.entryId),
    );
    const keep = firstUnobserved ?? units.at(-1);
    // The protected run request must survive compaction: carry it verbatim in the summary
    // when the kept range starts after it.
    const requestId = protectedRequestId(projection);
    const requestIndex = units.findIndex((unit) => unit.entryId === requestId);
    const request =
      requestIndex >= 0 && keep && requestIndex < units.indexOf(keep)
        ? units[requestIndex]!.messages.map((message) => {
            const content = (message as { content?: unknown }).content;
            return typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter((b): b is { type: "text"; text: string } => b?.type === "text")
                    .map((b) => b.text)
                    .join("\n")
                : "";
          }).join("\n")
        : undefined;
    if (!keep) return undefined;
    this.record("compaction", startedAt, host);
    return {
      firstKeptEntryId: keep.entryId,
      // Unique per compaction: Pi finds the new compaction entry by its summary text.
      summary: `Earlier conversation in this session (before entry ${keep.entryId}) is preserved in observational memory, generation ${state.generation}, ${state.activated.length} activated chunks (the observational-memory system section). Raw messages remain available through om_recall.${request ? `\n\nThe user's current request, verbatim:\n<current-request>\n${request}\n</current-request>` : ""}`,
    };
  }

  /** `session_compact`: the compaction landed, so pending activations can be written now. */
  onCompacted(host: Host): void {
    if (this.disposed) return;
    this.appendPending(host, { includeActivations: true });
  }

  // ---------------------------------------------------------------------------
  // Status for UI, tools and tests
  // ---------------------------------------------------------------------------

  snapshot(host: Host): {
    state: OMState;
    status: OMStatus;
    bufferInFlight: boolean;
    reflectionInFlight: boolean;
    bufferedReflectionTokens?: number;
    models: string[];
    disabledReason?: string;
    lastError?: string;
    lastFailover?: string;
  } {
    const state = this.state(host);
    return {
      state,
      status: computeStatus(this.units(host.projection()), state, this.config),
      bufferInFlight: Boolean(this.bufferOp),
      reflectionInFlight: Boolean(this.reflectionOp),
      bufferedReflectionTokens: this.bufferedReflection?.observationTokens,
      models: this.models(host).map((model) => `${model.provider}/${model.id}`),
      disabledReason: this.disabledReason(host),
      lastError: this.lastError,
      lastFailover: this.lastFailover,
    };
  }

  /** Lifetime of the cache the main model writes (Pi getPromptCacheTtlMs, then Mastra's table). */
  cacheTtlMs(host: Host): number | undefined {
    const model = host.model;
    if (!model) return undefined;
    const env = host.env ?? process.env;
    const retention = env.PI_CACHE_RETENTION === "long" ? "long" : "short";
    const seconds = (model as { promptCache?: Partial<Record<"short" | "long", number>> })
      .promptCache?.[retention];
    if (seconds !== undefined) return seconds * 1_000;
    return resolveActivationTTL("auto", { provider: model.provider, modelId: model.id });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private disabledReason(host: Host): string | undefined {
    if (this.config.disabled) return "disabled by PI_OM_DISABLE";
    if (resolveModelCandidates(host.registry, this.config.modelOverride).length === 0) {
      return "no observer model: sign in to Codex or Anthropic, or set PI_OM_MODEL=provider/model";
    }
    return undefined;
  }

  /** Observer/reflector models; empty when OM may not start new model work. */
  private models(host: Host): Model<Api>[] {
    if (this.config.disabled) return [];
    return resolveModelCandidates(host.registry, this.config.modelOverride);
  }

  private state(host: Host): OMState {
    return replayState(host.branch(), this.pending);
  }

  /**
   * Context units in order. An entry counts as read once the model has produced a response
   * after it: everything before the newest assistant message, plus assistant output itself.
   * This is structural, so it survives restarts and aborted runs.
   */
  private units(entries: readonly ProjectedSessionEntry[]): ContextUnit[] {
    const visible = entries.filter((entry) => entry.messages.length > 0);
    let lastAssistant = -1;
    visible.forEach((entry, index) => {
      if (entry.messages.some((m) => (m as { role?: string }).role === "assistant")) {
        lastAssistant = index;
      }
    });
    return visible.map((entry, index) => {
      const role = (entry.messages[0] as { role?: string }).role;
      return describeUnit(
        entry.sourceEntry.id,
        entry.sourceEntry.type,
        entry.messages,
        this.tokens.count(entry.messages),
        role === "assistant" || index < lastAssistant,
      );
    });
  }

  private section(state: OMState, host: Host): string | undefined {
    const now = new Date(host.now());
    const key = [
      state.activated.join(","),
      state.reflection?.id ?? "",
      state.currentTask ?? "",
      state.suggestedResponse ?? "",
      now.toDateString(),
    ].join("|");
    if (this.sectionCache?.key === key) return this.sectionCache.section;
    const section = buildOMSection(state, now);
    this.sectionCache = { key, section };
    return section;
  }

  private backedOff(kind: BackoffKind, host: Host): boolean {
    const entry = this.backoff.get(kind);
    return entry !== undefined && host.now() < entry.until;
  }

  private bumpBackoff(kind: BackoffKind, host: Host): void {
    const previous = this.backoff.get(kind);
    const ms = previous ? Math.min(previous.ms * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
    this.backoff.set(kind, { until: host.now() + ms, ms });
  }

  private async prepareRunStart(
    projection: ProjectedSessionEntry[],
    host: Host,
    candidates: Model<Api>[],
  ): Promise<void> {
    const state = this.state(host);
    const units = this.units(projection);
    const status = computeStatus(units, state, this.config);
    const trigger = this.runStartTrigger(status, host);
    if (trigger && status.canActivate) {
      this.activate(state, units, status.pendingTokens, trigger, host);
    }

    await this.maybeReflect(host, candidates);

    const after = computeStatus(units, this.state(host), this.config);
    if (after.mustBlock && !this.backedOff("block", host)) {
      await this.blockingObserve(projection, host, candidates, "block");
    } else {
      this.maybeStartBuffer(after, this.state(host), host, candidates);
    }
  }

  /** Mastra `activate({ checkThreshold: true })`: provider change, cache TTL, or threshold. */
  private runStartTrigger(status: OMStatus, host: Host): ActivationTrigger | undefined {
    const branch = host.branch();
    let lastAssistant: { provider?: string; timestamp?: number } | undefined;
    let lastWarm = 0;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index]!;
      if (!lastAssistant && entry.type === "message") {
        const message = entry.message as { role?: string; provider?: string; timestamp?: number };
        if (message.role === "assistant") lastAssistant = message;
      }
      if (
        !lastWarm &&
        entry.type === "usage" &&
        (entry as { kind?: string }).kind === "cache_warm"
      ) {
        lastWarm = Date.parse(entry.timestamp);
      }
      if (lastAssistant && lastWarm) break;
    }
    if (
      this.config.activateOnProviderChange &&
      lastAssistant?.provider &&
      host.model?.provider &&
      lastAssistant.provider !== host.model.provider
    ) {
      return "provider_change";
    }
    const lastActivityAt = Math.max(lastAssistant?.timestamp ?? 0, lastWarm);
    const ttl = this.cacheTtlMs(host);
    if (lastActivityAt > 0 && ttl !== undefined && host.now() - lastActivityAt >= ttl) return "ttl";
    if (status.shouldObserve) return "threshold";
    return undefined;
  }

  private activate(
    state: OMState,
    units: readonly ContextUnit[],
    pendingTokens: number,
    trigger: ActivationTrigger,
    host: Host,
  ): number {
    const ready = activatableChunks(state, units);
    const count =
      trigger === "block"
        ? ready.length
        : selectActivationCount(ready, pendingTokens, this.config.retentionFloor);
    const chunks = ready.slice(0, count);
    if (chunks.length === 0) return 0;
    const messageTokens = chunks.reduce((total, chunk) => total + chunk.messageTokens, 0);
    this.pending.push({
      customType: OM_ACTIVATION,
      data: {
        v: 1,
        chunkIds: chunks.map((chunk) => chunk.id),
        trigger,
        at: host.now(),
        messageTokens,
      },
    });
    for (const chunk of chunks) {
      for (const entryId of chunk.entryIds) this.pendingEdits.add(entryId);
    }
    this.record(
      "activate",
      host.now(),
      host,
      `${chunks.length} chunks · ${trigger} · −${formatK(messageTokens)}`,
    );
    return chunks.length;
  }

  private maybeStartBuffer(
    status: OMStatus,
    state: OMState,
    host: Host,
    candidates: Model<Api>[],
  ): void {
    if (candidates.length === 0 || this.bufferOp || this.backedOff("buffer", host)) return;
    if (!shouldBuffer(status, this.config)) return;
    const slice = selectSafePrefix(status.unbuffered);
    if (slice.length === 0) return;
    const startedAt = host.now();
    const epoch = this.epoch;
    const op = this.observeChunk(slice, state, host, candidates)
      .then((chunk) => {
        if (this.disposed) return;
        if (epoch !== this.epoch) {
          this.record("dropped", startedAt, host, "chunk from another branch");
          return;
        }
        this.pending.push({ customType: OM_CHUNK, data: chunk });
        this.maybeApplyTitle(host, chunk);
        this.lastError = undefined;
        this.backoff.delete("buffer");
        this.record(
          "buffer",
          startedAt,
          host,
          `${formatK(chunk.messageTokens)} → ${formatK(chunk.observationTokens)}`,
        );
        if (host.isIdle()) this.appendPending(host, { includeActivations: false });
      })
      .catch((error: unknown) => {
        if (this.disposed) return;
        this.bumpBackoff("buffer", host);
        this.fail(host, error);
      })
      .finally(() => {
        if (this.bufferOp === op) this.bufferOp = undefined;
        this.refreshStatus();
      });
    this.bufferOp = op;
    this.refreshStatus();
  }

  private async observeChunk(
    units: readonly ContextUnit[],
    state: OMState,
    host: Host,
    candidates: Model<Api>[],
    signal?: AbortSignal,
  ): Promise<ChunkData> {
    const result = await observe(
      host.registry,
      candidates,
      {
        messages: units.flatMap((unit) => unit.messages),
        activeObservations: renderActiveObservations(state),
        priorCurrentTask: state.latestTask ?? state.currentTask,
        priorSuggestedResponse: state.latestSuggestion ?? state.suggestedResponse,
        priorThreadTitle: host.getSessionName?.(),
        previousObserverTokens: this.config.previousObserverTokens,
        toolResultMaxTokens: this.config.observerToolResultMaxTokens,
      },
      {
        signal: signal ? AbortSignal.any([this.abort.signal, signal]) : this.abort.signal,
        timeoutMs: this.config.modelCallTimeoutMs,
      },
    );
    if (result.failures.length > 0) this.recordFailover(host, result.failures, result.model);
    const entryIds = units.map((unit) => unit.entryId);
    return {
      v: 1,
      id: newId(),
      observations: result.observations,
      observationTokens: result.observationTokens,
      messageTokens: units.reduce((total, unit) => total + unit.tokens, 0),
      entryIds,
      range: `${entryIds[0]}:${entryIds.at(-1)}`,
      createdAt: host.now(),
      model: result.model,
      currentTask: result.currentTask,
      suggestedResponse: result.suggestedResponse,
      threadTitle: result.threadTitle,
    };
  }

  /**
   * Mastra Code threadTitle: apply the observer's title as the session name, unless the
   * session has a name OM did not set (the user named it, which pins it).
   */
  private maybeApplyTitle(host: Host, chunk: ChunkData): void {
    const title = chunk.threadTitle?.trim();
    if (!title || title.length < 3 || !host.setSessionName) return;
    const current = host.getSessionName?.()?.trim();
    if (current === title) return;
    if (current) {
      const omTitles = new Set(
        [...this.state(host).chunks.values()].map((c) => c.threadTitle?.trim()).filter(Boolean),
      );
      if (!omTitles.has(current)) return;
    }
    host.setSessionName(title);
  }

  /**
   * The only blocking path (Mastra sync observation at blockAfter). Waits a bounded time for
   * in-flight buffering, activates every ready chunk, then observes what is still unbuffered
   * and already read, in parallel batches, and activates the results. A failure backs the
   * path off instead of re-running the whole model chain every turn.
   */
  private async blockingObserve(
    entries: readonly ProjectedSessionEntry[],
    host: Host,
    candidates: Model<Api>[],
    trigger: "block" | "compaction",
    signal?: AbortSignal,
  ): Promise<void> {
    const startedAt = host.now();
    const epoch = this.epoch;
    this.blocking = "waiting for buffered observation";
    this.refreshStatus();
    try {
      await withTimeout(this.bufferOp, this.config.bufferWaitMs);
      let state = this.state(host);
      const units = this.units(entries);
      let status = computeStatus(units, state, this.config);
      this.activate(state, units, status.pendingTokens, trigger, host);
      state = this.state(host);
      status = computeStatus(units, state, this.config);
      if (trigger === "block" && !status.mustBlock) return;
      if (candidates.length === 0 || signal?.aborted) return;

      let remaining = status.unbuffered.filter((unit) => unit.read);
      if (trigger === "compaction") remaining = this.withoutRetainedTail(remaining);
      const safe = selectSafePrefix(remaining);
      if (safe.length === 0) return;
      this.blocking = `observing ${formatK(safe.reduce((total, unit) => total + unit.tokens, 0))}`;
      this.refreshStatus();
      const batches = this.batches(safe);
      const chunks: ChunkData[] = new Array(batches.length);
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const index = next++;
          chunks[index] = await this.observeChunk(batches[index]!, state, host, candidates, signal);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(BLOCKING_CONCURRENCY, batches.length) }, worker),
      );
      if (epoch !== this.epoch || this.disposed || signal?.aborted) return;
      for (const chunk of chunks) this.pending.push({ customType: OM_CHUNK, data: chunk });
      const titled = chunks.filter((chunk) => chunk.threadTitle).at(-1);
      if (titled) this.maybeApplyTitle(host, titled);
      state = this.state(host);
      status = computeStatus(units, state, this.config);
      this.activate(state, units, status.pendingTokens, trigger, host);
      this.backoff.delete("block");
      this.record("block", startedAt, host, `${batches.length} batches`);
    } catch (error) {
      if (!this.disposed && !signal?.aborted) {
        this.bumpBackoff("block", host);
        this.fail(host, error);
      }
    } finally {
      this.blocking = undefined;
      this.refreshStatus();
    }
  }

  /** Drops the newest units holding the retention floor, so compaction keeps a raw tail. */
  private withoutRetainedTail(units: readonly ContextUnit[]): ContextUnit[] {
    let kept = 0;
    let cut = units.length;
    while (cut > 0 && kept < this.config.retentionFloor) {
      cut -= 1;
      kept += units[cut]!.tokens;
    }
    return units.slice(0, cut);
  }

  /** Split at safe boundaries into batches near twice the buffer interval. */
  private batches(units: readonly ContextUnit[]): ContextUnit[][] {
    const limit = this.config.bufferTokens * BLOCKING_BATCH_FACTOR;
    const batches: ContextUnit[][] = [];
    let current: ContextUnit[] = [];
    let tokens = 0;
    for (const unit of units) {
      current.push(unit);
      tokens += unit.tokens;
      if (tokens >= limit && selectSafePrefix(current).length === current.length) {
        batches.push(current);
        current = [];
        tokens = 0;
      }
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  private async maybeReflect(host: Host, candidates: Model<Api>[]): Promise<void> {
    if (candidates.length === 0) return;
    let state = this.state(host);
    if (this.bufferedReflection && !this.reflectionBasisValid(this.bufferedReflection, state)) {
      this.bufferedReflection = undefined;
    }
    const decision = decideReflection({
      observationTokens: state.observationTokens,
      hasBufferedReflection: Boolean(this.bufferedReflection),
      reflectionInFlight: Boolean(this.reflectionOp),
      config: this.config,
    });
    switch (decision.kind) {
      case "none":
        return;
      case "start-buffer":
        if (!this.backedOff("reflect", host)) this.startReflectionBuffer(state, host, candidates);
        return;
      case "activate-buffer":
        this.activateBufferedReflection(state, host);
        return;
      case "sync": {
        if (this.backedOff("reflect", host)) return;
        const startedAt = host.now();
        const epoch = this.epoch;
        this.blocking = "reflecting";
        this.refreshStatus();
        try {
          await withTimeout(this.reflectionOp, this.config.bufferWaitMs);
          state = this.state(host);
          if (
            this.bufferedReflection &&
            this.reflectionBasisValid(this.bufferedReflection, state)
          ) {
            this.activateBufferedReflection(state, host);
            return;
          }
          const result = await reflect(
            host.registry,
            candidates,
            renderActiveObservations(state),
            this.config.reflectionTokens,
            { signal: this.abort.signal, timeoutMs: this.config.modelCallTimeoutMs },
          );
          if (epoch !== this.epoch || this.disposed) return;
          if (result.failures.length > 0) this.recordFailover(host, result.failures, result.model);
          this.pushReflection(state, host, {
            baseReflectionId: state.reflection?.id,
            chunkIds: state.activeChunks.map((chunk) => chunk.id),
            inputTokens: state.observationTokens,
            ...result,
          });
          this.backoff.delete("reflect");
          this.record(
            "reflect-sync",
            startedAt,
            host,
            `${formatK(state.observationTokens)} → ${formatK(result.observationTokens)}`,
          );
        } catch (error) {
          if (!this.disposed) {
            this.bumpBackoff("reflect", host);
            this.fail(host, error);
          }
        } finally {
          this.blocking = undefined;
          this.refreshStatus();
        }
        return;
      }
    }
  }

  /** A buffered reflection applies only to the generation and active chunks it read. */
  private reflectionBasisValid(buffered: BufferedReflection, state: OMState): boolean {
    if (buffered.baseReflectionId !== state.reflection?.id) return false;
    const active = new Set(state.activeChunks.map((chunk) => chunk.id));
    return buffered.chunkIds.every((id) => active.has(id));
  }

  private startReflectionBuffer(state: OMState, host: Host, candidates: Model<Api>[]): void {
    const slice = selectReflectionSlice(state, this.config.reflectionBufferAt);
    const sliceChunks = new Set(slice.chunkIds);
    const parts: string[] = [];
    if (state.reflection) parts.push(state.reflection.observations);
    for (const chunk of state.activeChunks) {
      if (sliceChunks.has(chunk.id)) {
        parts.push(wrapInObservationGroup(chunk.observations, chunk.range, chunk.id));
      }
    }
    const startedAt = host.now();
    const epoch = this.epoch;
    const op = reflect(
      host.registry,
      candidates,
      parts.join("\n\n"),
      Math.round(slice.tokens * 0.75),
      {
        signal: this.abort.signal,
        timeoutMs: this.config.modelCallTimeoutMs,
      },
    )
      .then((result) => {
        if (this.disposed || epoch !== this.epoch) return;
        if (result.failures.length > 0) this.recordFailover(host, result.failures, result.model);
        this.bufferedReflection = {
          baseReflectionId: state.reflection?.id,
          chunkIds: slice.chunkIds,
          inputTokens: slice.tokens,
          ...result,
        };
        this.backoff.delete("reflect");
        this.record(
          "reflect-buffer",
          startedAt,
          host,
          `${formatK(slice.tokens)} → ${formatK(result.observationTokens)}`,
        );
      })
      .catch((error: unknown) => {
        if (this.disposed) return;
        this.bumpBackoff("reflect", host);
        this.fail(host, error);
      })
      .finally(() => {
        if (this.reflectionOp === op) this.reflectionOp = undefined;
        this.refreshStatus();
      });
    this.reflectionOp = op;
    this.refreshStatus();
  }

  private activateBufferedReflection(state: OMState, host: Host): void {
    const buffered = this.bufferedReflection;
    if (!buffered) return;
    this.bufferedReflection = undefined;
    this.pushReflection(state, host, buffered);
    this.record(
      "reflect-activate",
      host.now(),
      host,
      `${formatK(buffered.inputTokens)} → ${formatK(buffered.observationTokens)}`,
    );
  }

  private pushReflection(state: OMState, host: Host, result: BufferedReflection): void {
    const folded = new Set([...(state.reflection?.foldedChunkIds ?? []), ...result.chunkIds]);
    const data: ReflectionData = {
      v: 1,
      id: newId(),
      generation: state.generation + 1,
      observations: result.observations,
      observationTokens: result.observationTokens,
      foldedChunkIds: [...folded],
      at: host.now(),
      model: result.model,
      currentTask: result.currentTask,
      suggestedResponse: result.suggestedResponse,
    };
    this.pending.push({ customType: OM_REFLECTION, data });
  }

  /**
   * Boundary drafts: OM entries first, then context edits for entries Pi can still edit.
   * Every edit target must be a projected, editable entry or Pi rejects the whole boundary.
   */
  private flushDrafts(
    entries: readonly ProjectedSessionEntry[],
    host: Host,
  ): SessionBoundaryDraft[] {
    const drafts: SessionBoundaryDraft[] = this.pending.map((draft) => ({
      type: "custom" as const,
      customType: draft.customType,
      data: draft.data,
    }));
    // Every observed entry that is still in context gets its edit, except the protected
    // run request. That also commits edits deferred while an entry was protected.
    const state = this.state(host);
    const keepRaw = protectedRequestId(entries);
    for (const unit of this.units(entries)) {
      if (!unit.observable || unit.entryId === keepRaw) continue;
      if (state.observedEntryIds.has(unit.entryId) || this.pendingEdits.has(unit.entryId)) {
        drafts.push({ type: "context_edit", targetId: unit.entryId, replacement: null });
      }
    }
    this.pending = [];
    this.pendingEdits.clear();
    return drafts;
  }

  /** Writes pending drafts outside a boundary. Activations need their edits, so they wait. */
  private appendPending(host: Host, options: { includeActivations: boolean }): void {
    if (this.disposed) return;
    const keep: OMEntryDraft[] = [];
    for (const draft of this.pending) {
      if (draft.customType === OM_ACTIVATION && !options.includeActivations) keep.push(draft);
      else host.appendEntry(draft.customType, draft.data);
    }
    this.pending = keep;
  }

  /** A call succeeded only after retries or another model: make that visible, not silent. */
  private recordFailover(host: Host, failures: readonly string[], model: string): void {
    this.lastFailover = `${failures.join("; ")} → ${model}`;
    this.record("failover", host.now(), host, this.lastFailover);
  }

  private fail(host: Host, error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.record("error", host.now(), host, this.lastError);
  }

  private record(kind: OMEventKind, startedAt: number, host: Host, detail?: string): void {
    const event: OMEvent = { kind, at: startedAt, ms: host.now() - startedAt, detail };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    if (this.config.tracePath) {
      try {
        appendFileSync(
          this.config.tracePath,
          `${JSON.stringify({ session: this.sessionId, ...event })}\n`,
        );
      } catch {
        // Tracing is diagnostic only.
      }
    }
  }

  private refreshStatus(): void {
    const host = this.lastHost;
    if (!host || this.disposed) return;
    try {
      this.updateStatus(host, host.projection(), this.state(host));
    } catch {
      // Status is best-effort; a stale host must never break background work.
    }
  }

  private updateStatus(
    host: Host,
    entries: readonly ProjectedSessionEntry[],
    state: OMState,
  ): void {
    const status = computeStatus(this.units(entries), state, this.config);
    const parts = [
      `OM ${formatK(status.pendingTokens)}/${formatK(status.threshold)}`,
      `mem ${formatK(state.observationTokens)}/${formatK(this.config.reflectionTokens)}`,
    ];
    const off = this.disabledReason(host);
    if (off) parts.push(`paused · ${off}`);
    else if (this.blocking) parts.push(`⏳ ${this.blocking}`);
    else {
      if (this.bufferOp) parts.push("observing…");
      if (this.reflectionOp) parts.push("reflecting…");
    }
    if (this.lastError) parts.push("⚠ last OM call failed (/om)");
    else if (this.lastFailover) parts.push("⚠ OM model fell back (/om)");
    host.setStatus(parts.join(" · "));
  }
}
