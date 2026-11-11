import { randomBytes } from "node:crypto";
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
import { EntryTokenCache } from "./tokens.js";
import { resolveActivationTTL } from "./upstream/activation-ttl";

/** What the runtime needs from Pi for one hook invocation. */
export interface Host {
  registry: ModelAccess;
  model: Model<Api> | undefined;
  branch(): SessionEntry[];
  projection(): ProjectedSessionEntry[];
  isIdle(): boolean;
  appendEntry(customType: string, data: unknown): void;
  setStatus(text: string | undefined): void;
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

const MAX_EVENTS = 200;
const BLOCKING_BATCH_FACTOR = 2;
const BLOCKING_CONCURRENCY = 4;

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
 */
export class SessionOM {
  private pending: OMEntryDraft[] = [];
  private readonly pendingEdits = new Set<string>();
  private readonly sent = new Set<string>();
  private readonly tokens = new EntryTokenCache();
  private bufferOp: Promise<void> | undefined;
  private reflectionOp: Promise<void> | undefined;
  private bufferedReflection: BufferedReflection | undefined;
  private firstRequestOfRun = true;
  private runStartedAt = 0;
  private readonly abort = new AbortController();
  private disposed = false;
  private lastHost: Host | undefined;
  private lastState: OMState | undefined;
  private lastError: string | undefined;
  private blocking: string | undefined;
  private sectionCache: { key: string; section: string | undefined } | undefined;
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

  startRun(host: Host): void {
    this.firstRequestOfRun = true;
    this.runStartedAt = host.now();
  }

  /** `context`: run-start activation, request-local omission, continuation reminder. */
  async onContext(messages: AgentMessage[], host: Host): Promise<AgentMessage[] | undefined> {
    this.lastHost = host;
    const startedAt = host.now();
    const candidates = this.candidates(host);
    if (!candidates) return undefined;

    const projection = host.projection();
    const entryByKey = new Map<string, string>();
    for (const entry of projection) {
      for (const message of entry.messages)
        entryByKey.set(messageKey(message), entry.sourceEntry.id);
    }

    if (this.firstRequestOfRun) {
      this.firstRequestOfRun = false;
      // Everything that existed before this run has been read by the model already.
      for (const entry of projection) {
        if (Date.parse(entry.sourceEntry.timestamp) < this.runStartedAt)
          this.sent.add(entry.sourceEntry.id);
      }
      await this.prepareRunStart(projection, host, candidates);
    }

    const state = this.state(host);
    const kept = messages.filter((message) => {
      const entryId = entryByKey.get(messageKey(message));
      return !(entryId && state.observedEntryIds.has(entryId));
    });
    for (const message of kept) {
      const entryId = entryByKey.get(messageKey(message));
      if (entryId) this.sent.add(entryId);
    }
    this.updateStatus(host, projection, state);
    this.record("context", startedAt, host, `${messages.length}→${kept.length} msgs`);

    if (!hasActiveMemory(state)) return kept.length === messages.length ? undefined : kept;
    return [
      { role: "user", content: CONTINUATION_REMINDER, timestamp: 0 } as AgentMessage,
      ...kept,
    ];
  }

  /** `context_with_system`: put active memory in the leading system message's OM section. */
  onSystem(messages: AgentMessage[], host: Host): AgentMessage[] | undefined {
    if (!this.candidates(host)) return undefined;
    const lead = messages[0] as
      | { role?: string; sections?: Record<string, string | null> }
      | undefined;
    if (!lead || lead.role !== "system") return undefined;
    const section = this.section(this.lastState ?? this.state(host), host);
    if (section === undefined && lead.sections?.[OM_SECTION] === undefined) return undefined;
    const sections = { ...(lead.sections ?? {}) };
    if (section === undefined) delete sections[OM_SECTION];
    else sections[OM_SECTION] = section;
    return [{ ...(messages[0] as object), sections } as AgentMessage, ...messages.slice(1)];
  }

  /** `turn_end`: buffer, activate in band, block only at blockAfter, reflect, commit. */
  async onTurnEnd(
    input: {
      contextEntries: ProjectedSessionEntry[];
      messageEntryId?: string;
    },
    host: Host,
  ): Promise<SessionBoundaryDraft[]> {
    this.lastHost = host;
    const startedAt = host.now();
    const candidates = this.candidates(host);
    if (!candidates) return [];
    if (input.messageEntryId) this.sent.add(input.messageEntryId);

    let state = this.state(host);
    let units = this.units(input.contextEntries);
    let status = computeStatus(units, state, this.config);

    // Mastra: in the threshold→blockAfter band with a chunk ready, activate instead of buffering.
    const activateBeforeBuffering = status.inBand && status.canActivate;
    if (!activateBeforeBuffering && !this.bufferOp && shouldBuffer(status, this.config)) {
      this.startBuffer(status, state, host, candidates);
    }

    if (status.shouldObserve && status.canActivate) {
      this.activate(state, units, status.pendingTokens, "threshold", host);
      state = this.state(host);
      status = computeStatus(units, state, this.config);
    }

    if (status.mustBlock) {
      await this.blockingObserve(input.contextEntries, host, candidates, "block");
      state = this.state(host);
      units = this.units(input.contextEntries);
      status = computeStatus(units, state, this.config);
    }

    await this.maybeReflect(host, candidates, true);
    state = this.state(host);
    this.updateStatus(host, input.contextEntries, state);
    this.record("turn_end", startedAt, host, `pending ${formatK(status.pendingTokens)}`);
    return this.flushDrafts(input.contextEntries);
  }

  /** `agent_before_settle`: commit what is pending and keep buffering while idle. */
  onSettle(input: { contextEntries: ProjectedSessionEntry[] }, host: Host): SessionBoundaryDraft[] {
    this.lastHost = host;
    const startedAt = host.now();
    const candidates = this.candidates(host);
    if (!candidates) return [];
    const state = this.state(host);
    const units = this.units(input.contextEntries);
    const status = computeStatus(units, state, this.config);
    if (!this.bufferOp && shouldBuffer(status, this.config)) {
      this.startBuffer(status, state, host, candidates);
    }
    this.updateStatus(host, input.contextEntries, state);
    this.record("settle", startedAt, host);
    return this.flushDrafts(input.contextEntries);
  }

  /**
   * `session_before_compact`: bring memory fully up to date and replace Pi's summarizer.
   * Returns the entry id to keep from, or undefined to let Pi compact natively.
   */
  async onCompact(host: Host): Promise<{ firstKeptEntryId: string; summary: string } | undefined> {
    this.lastHost = host;
    const startedAt = host.now();
    const candidates = this.candidates(host);
    if (!candidates) return undefined;
    const projection = host.projection();
    try {
      await this.blockingObserve(projection, host, candidates, "compaction");
    } catch (error) {
      this.fail(host, error);
      return undefined;
    }
    // Compaction drops everything before the kept entry, so context edits are moot.
    this.pendingEdits.clear();
    this.flushIdle(host, true);
    const state = this.state(host);
    const units = this.units(projection);
    const firstUnobserved = units.find(
      (unit) => unit.observable && !state.observedEntryIds.has(unit.entryId),
    );
    const keep = firstUnobserved ?? units.at(-1);
    if (!keep || !hasActiveMemory(state)) return undefined;
    this.record("compaction", startedAt, host);
    return {
      firstKeptEntryId: keep.entryId,
      summary:
        "Earlier conversation in this session is preserved in observational memory (the observational-memory system section). Raw messages remain available through om_recall.",
    };
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
  } {
    const state = this.state(host);
    const status = computeStatus(this.units(host.projection()), state, this.config);
    const candidates = this.candidates(host);
    return {
      state,
      status,
      bufferInFlight: Boolean(this.bufferOp),
      reflectionInFlight: Boolean(this.reflectionOp),
      bufferedReflectionTokens: this.bufferedReflection?.observationTokens,
      models: (candidates ?? []).map((model) => `${model.provider}/${model.id}`),
      disabledReason: this.disabledReason(host),
      lastError: this.lastError,
    };
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

  private candidates(host: Host): Model<Api>[] | undefined {
    if (this.config.disabled || this.disposed) return undefined;
    const candidates = resolveModelCandidates(host.registry, this.config.modelOverride);
    if (candidates.length === 0) {
      host.setStatus(`OM off · ${this.disabledReason(host)}`);
      return undefined;
    }
    return candidates;
  }

  private state(host: Host): OMState {
    const state = replayState(host.branch(), this.pending);
    this.lastState = state;
    return state;
  }

  private units(entries: readonly ProjectedSessionEntry[]): ContextUnit[] {
    const units: ContextUnit[] = [];
    for (const entry of entries) {
      if (entry.messages.length === 0) continue;
      const id = entry.sourceEntry.id;
      units.push(
        describeUnit(id, entry.messages, this.tokens.count(id, entry.messages), this.sent.has(id)),
      );
    }
    return units;
  }

  private section(state: OMState, host: Host): string | undefined {
    const now = new Date(host.now());
    const day = now.toDateString();
    const key = `${state.activated.length}|${state.reflection?.id ?? ""}|${state.currentTask ?? ""}|${state.suggestedResponse ?? ""}|${day}`;
    if (this.sectionCache?.key === key) return this.sectionCache.section;
    const section = buildOMSection(state, now);
    this.sectionCache = { key, section };
    return section;
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
    if (trigger && status.canActivate)
      this.activate(state, units, status.pendingTokens, trigger, host);

    await this.maybeReflect(host, candidates, true);

    const after = computeStatus(this.units(projection), this.state(host), this.config);
    if (after.mustBlock) await this.blockingObserve(projection, host, candidates, "block");
    else if (!this.bufferOp && shouldBuffer(after, this.config)) {
      this.startBuffer(after, this.state(host), host, candidates);
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
    for (const chunk of chunks)
      for (const entryId of chunk.entryIds) this.pendingEdits.add(entryId);
    this.record(
      "activate",
      host.now(),
      host,
      `${chunks.length} chunks · ${trigger} · −${formatK(messageTokens)}`,
    );
    return chunks.length;
  }

  private startBuffer(
    status: OMStatus,
    state: OMState,
    host: Host,
    candidates: Model<Api>[],
  ): void {
    const slice = selectSafePrefix(status.unbuffered);
    if (slice.length === 0) return;
    const startedAt = host.now();
    const op = this.observeChunk(slice, state, host, candidates)
      .then((chunk) => {
        this.pending.push({ customType: OM_CHUNK, data: chunk });
        this.lastError = undefined;
        this.record(
          "buffer",
          startedAt,
          host,
          `${formatK(chunk.messageTokens)} → ${formatK(chunk.observationTokens)}`,
        );
        this.flushIdle(host);
      })
      .catch((error: unknown) => {
        if (!this.disposed) this.fail(host, error);
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
  ): Promise<ChunkData> {
    const result = await observe(
      host.registry,
      candidates,
      {
        messages: units.flatMap((unit) => unit.messages),
        activeObservations: renderActiveObservations(state),
        priorCurrentTask: state.currentTask,
        priorSuggestedResponse: state.suggestedResponse,
        previousObserverTokens: this.config.previousObserverTokens,
        toolResultMaxTokens: this.config.observerToolResultMaxTokens,
      },
      { signal: this.abort.signal, timeoutMs: this.config.modelCallTimeoutMs },
    );
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
    };
  }

  /**
   * The only blocking path (Mastra sync observation at blockAfter). Waits a bounded time for
   * in-flight buffering, activates every ready chunk, then observes what is still unbuffered
   * and already read, in parallel batches, and activates the results.
   */
  private async blockingObserve(
    entries: readonly ProjectedSessionEntry[],
    host: Host,
    candidates: Model<Api>[],
    trigger: "block" | "compaction",
  ): Promise<void> {
    const startedAt = host.now();
    this.blocking = "waiting for buffered observation";
    this.refreshStatus();
    try {
      await withTimeout(this.bufferOp, this.config.bufferWaitMs);
      let state = this.state(host);
      let units = this.units(entries);
      let status = computeStatus(units, state, this.config);
      this.activate(state, units, status.pendingTokens, trigger, host);
      state = this.state(host);
      status = computeStatus(units, state, this.config);
      if (trigger === "block" && !status.mustBlock) return;

      let remaining = status.unbuffered.filter((unit) => unit.read);
      if (trigger === "compaction") remaining = this.withoutRetainedTail(remaining);
      const safe = selectSafePrefix(remaining);
      if (safe.length === 0) return;
      this.blocking = `observing ${formatK(safe.reduce((t, u) => t + u.tokens, 0))}`;
      this.refreshStatus();
      const batches = this.batches(safe);
      const chunks: ChunkData[] = new Array(batches.length);
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const index = next++;
          chunks[index] = await this.observeChunk(batches[index]!, state, host, candidates);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(BLOCKING_CONCURRENCY, batches.length) }, worker),
      );
      for (const chunk of chunks) this.pending.push({ customType: OM_CHUNK, data: chunk });
      state = this.state(host);
      units = this.units(entries);
      status = computeStatus(units, state, this.config);
      this.activate(state, units, status.pendingTokens, trigger, host);
      this.record("block", startedAt, host, `${batches.length} batches`);
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
    const open = new Set<string>();
    for (const unit of units) {
      current.push(unit);
      tokens += unit.tokens;
      for (const id of unit.toolCallIds) open.add(id);
      for (const id of unit.toolResultIds) open.delete(id);
      if (tokens >= limit && open.size === 0) {
        batches.push(current);
        current = [];
        tokens = 0;
      }
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  private async maybeReflect(
    host: Host,
    candidates: Model<Api>[],
    allowBlock: boolean,
  ): Promise<void> {
    let state = this.state(host);
    if (
      this.bufferedReflection &&
      this.bufferedReflection.baseReflectionId !== state.reflection?.id
    ) {
      this.bufferedReflection = undefined; // computed against a generation that is gone
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
        this.startReflectionBuffer(state, host, candidates);
        return;
      case "activate-buffer":
        this.activateBufferedReflection(state, host);
        return;
      case "sync": {
        if (!allowBlock) return;
        const startedAt = host.now();
        this.blocking = "reflecting";
        this.refreshStatus();
        try {
          await withTimeout(this.reflectionOp, this.config.bufferWaitMs);
          state = this.state(host);
          if (
            this.bufferedReflection?.baseReflectionId === state.reflection?.id &&
            this.bufferedReflection
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
          this.pushReflection(state, host, {
            baseReflectionId: state.reflection?.id,
            chunkIds: state.activeChunks.map((chunk) => chunk.id),
            inputTokens: state.observationTokens,
            ...result,
          });
          this.record(
            "reflect-sync",
            startedAt,
            host,
            `${formatK(state.observationTokens)} → ${formatK(result.observationTokens)}`,
          );
        } catch (error) {
          this.fail(host, error);
        } finally {
          this.blocking = undefined;
          this.refreshStatus();
        }
        return;
      }
    }
  }

  private startReflectionBuffer(state: OMState, host: Host, candidates: Model<Api>[]): void {
    const slice = selectReflectionSlice(state, this.config.reflectionBufferAt);
    const sliceChunks = new Set(slice.chunkIds);
    const parts: string[] = [];
    if (state.reflection) parts.push(state.reflection.observations);
    for (const chunk of state.activeChunks)
      if (sliceChunks.has(chunk.id)) parts.push(chunk.observations);
    const input = parts.join("\n\n");
    const startedAt = host.now();
    const op = reflect(host.registry, candidates, input, Math.round(slice.tokens * 0.75), {
      signal: this.abort.signal,
      timeoutMs: this.config.modelCallTimeoutMs,
    })
      .then((result) => {
        this.bufferedReflection = {
          baseReflectionId: state.reflection?.id,
          chunkIds: slice.chunkIds,
          inputTokens: slice.tokens,
          ...result,
        };
        this.record(
          "reflect-buffer",
          startedAt,
          host,
          `${formatK(slice.tokens)} → ${formatK(result.observationTokens)}`,
        );
      })
      .catch((error: unknown) => {
        if (!this.disposed) this.fail(host, error);
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

  /** Boundary drafts: OM entries first, then context edits for entries still in context. */
  private flushDrafts(entries: readonly ProjectedSessionEntry[]): SessionBoundaryDraft[] {
    const drafts: SessionBoundaryDraft[] = this.pending.map((draft) => ({
      type: "custom" as const,
      customType: draft.customType,
      data: draft.data,
    }));
    const projected = new Set(
      entries.filter((entry) => entry.messages.length > 0).map((entry) => entry.sourceEntry.id),
    );
    for (const entryId of this.pendingEdits) {
      if (projected.has(entryId))
        drafts.push({ type: "context_edit", targetId: entryId, replacement: null });
    }
    this.pending = [];
    this.pendingEdits.clear();
    return drafts;
  }

  /**
   * Write entries that need no context edit while Pi is idle. Activations wait for a
   * boundary so their edits commit with them, unless `force` (compaction).
   */
  private flushIdle(host: Host, force = false): void {
    if (this.disposed) return;
    if (!force && !host.isIdle()) return;
    const keep: OMEntryDraft[] = [];
    const hasEdits = this.pendingEdits.size > 0 && !force;
    for (const draft of this.pending) {
      if (draft.customType === OM_ACTIVATION && hasEdits) keep.push(draft);
      else host.appendEntry(draft.customType, draft.data);
    }
    this.pending = keep;
  }

  private fail(host: Host, error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.record("error", host.now(), host, this.lastError);
  }

  private record(kind: OMEventKind, startedAt: number, host: Host, detail?: string): void {
    this.events.push({ kind, at: startedAt, ms: host.now() - startedAt, detail });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
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
    if (this.blocking) parts.push(`⏳ ${this.blocking}`);
    else {
      if (this.bufferOp) parts.push("observing…");
      if (this.reflectionOp) parts.push("reflecting…");
    }
    if (this.lastError) parts.push("⚠ last OM call failed (/om)");
    host.setStatus(parts.join(" · "));
  }
}
