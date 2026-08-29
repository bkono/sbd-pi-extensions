import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { logger } from "../logger.js";
import { PARENT_ONLY_MINION_TOOLS } from "../orchestration/comm.js";
import { formatToolCall } from "../render.js";
import type { EventBus } from "./event-bus.js";
import { MINION_COMPLETE_CHANNEL, MINION_PROGRESS_CHANNEL } from "./event-bus.js";
import { getMinionsDir } from "./paths.js";
import type {
  ChildRuntime,
  ChildSession,
  ChildSessionEvent,
  ChildTerminalEvent,
  CreateChildRuntime,
  CreateMinionSessionOptions,
  MinionSessionHandle,
  MinionSessionMetadata,
} from "./types.js";

const MINION_EXTENSION_EXCLUDE_FRAGMENTS = ["pi-minions", "pi-om-extension"];

/** AgentSession may re-queue events; bound the private-queue drain. */
const SESSION_EVENT_QUEUE_DRAIN_LIMIT = 100;
/** Microtask yields so fakes can deliver turn_end after waitForIdle. */
const TRAILING_EVENT_MICROTASK_BUDGET = 8;

export function shouldLoadExtensionInMinion(resolvedPath: string): boolean {
  return !MINION_EXTENSION_EXCLUDE_FRAGMENTS.some((fragment) => resolvedPath.includes(fragment));
}

/** Beadwork inspection tools every child may use. String names only; do not import beadwork. */
export const BEADWORK_CHILD_INSPECTION_TOOLS = [
  "beadwork_show",
  "beadwork_list_issues",
  "beadwork_issue_history",
  "beadwork_ready",
  "beadwork_blocked",
  "beadwork_status",
  "beadwork_prime",
] as const;

const BEADWORK_CHILD_INSPECTION_TOOL_SET: ReadonlySet<string> = new Set(
  BEADWORK_CHILD_INSPECTION_TOOLS,
);

/** True for any beadwork_* name outside the child inspection allowlist. */
export function isDeniedChildBeadworkTool(name: string): boolean {
  return name.startsWith("beadwork_") && !BEADWORK_CHILD_INSPECTION_TOOL_SET.has(name);
}

export interface ChildToolAllowlistInput {
  roleAllowlist?: readonly string[];
  parentCodingTools?: readonly string[];
  /** Orchestrated-only comm tools. Spawn leaves this empty so later tickets can union without rewriting. */
  extraTools?: readonly string[];
  currentActiveTools?: readonly string[];
}

/**
 * Child tool formula (spawn and orchestrate):
 *   (role allowlist if present, else parent coding tools minus every beadwork_*)
 *     ∪ beadwork inspection allowlist
 *     ∪ extraTools (orchestrated comm hook; not beadwork_*)
 *     − every beadwork_* not in the inspection set
 *
 * Parent `getAllTools()` is not a coding-tools base: it includes beadwork
 * mutations. Those names may still be passed in so tool-sync can wait for
 * late registration; this formula strips them from the active set.
 */
export function computeChildActiveTools(input: ChildToolAllowlistInput): string[] {
  const role = input.roleAllowlist?.filter((name) => name.length > 0) ?? [];
  const parent = input.parentCodingTools?.filter((name) => name.length > 0) ?? [];
  const current = input.currentActiveTools?.filter((name) => name.length > 0) ?? [];
  const base = role.length > 0 ? role : parent.length > 0 ? parent : current;

  const names = new Set<string>();
  for (const name of base) {
    if (isDeniedChildBeadworkTool(name)) continue;
    names.add(name);
  }
  for (const tool of BEADWORK_CHILD_INSPECTION_TOOLS) names.add(tool);
  for (const tool of input.extraTools ?? []) {
    if (tool.length === 0 || isDeniedChildBeadworkTool(tool)) continue;
    names.add(tool);
  }
  for (const name of [...names]) {
    if (isDeniedChildBeadworkTool(name)) names.delete(name);
  }
  return [...names];
}

export function applyChildToolAllowlist(
  session: Pick<ChildSession, "setActiveToolsByName" | "getActiveToolNames">,
  input: ChildToolAllowlistInput,
): string[] {
  const names = computeChildActiveTools({
    ...input,
    currentActiveTools: input.currentActiveTools ?? session.getActiveToolNames(),
  });
  session.setActiveToolsByName(names);
  return session.getActiveToolNames();
}

async function defaultCreateChildRuntime(
  input: Parameters<CreateChildRuntime>[0],
): Promise<{ runtime: ChildRuntime; sessionPath: string }> {
  const minionsDir = getMinionsDir(input.cwd);
  mkdirSync(minionsDir, { recursive: true });
  const sessionPath = join(minionsDir, `${input.id}.${input.name}.jsonl`);
  const sessionManager = SessionManager.create(input.cwd, minionsDir);
  const actualPath = sessionManager.getSessionFile() ?? sessionPath;

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(input.cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir,
    settingsManager,
    noExtensions: false,
    noSkills: false,
    noPromptTemplates: false,
    noThemes: false,
    systemPromptOverride: input.parentSystemPrompt
      ? () => input.parentSystemPrompt ?? ""
      : input.config.systemPrompt
        ? () => input.config.systemPrompt
        : undefined,
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((ext) => shouldLoadExtensionInMinion(ext.resolvedPath)),
    }),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir,
    model: input.parentModel,
    customTools: input.customTools,
    sessionManager,
    settingsManager,
    resourceLoader: loader,
  });

  return {
    sessionPath: actualPath,
    runtime: {
      session: session as unknown as ChildSession,
      dispose: () => {
        try {
          session.abortBash();
        } catch {
          // Unmanaged processes cannot be guaranteed.
        }
        session.dispose();
      },
    },
  };
}

/** First terminal commit wins. Logged; not a wait-state machine. */
export type TerminalWinner = "settle" | "fail" | "abort" | "shutdown" | "mail-then-settle";

interface ChildRecord {
  id: string;
  runtime: ChildRuntime;
  session: ChildSession;
  options: CreateMinionSessionOptions;
  abortRequested: boolean;
  pendingFailure?: string;
  terminal?: ChildTerminalEvent;
  waiters: Array<(event: ChildTerminalEvent) => void>;
  currentFullText: string;
  turnCount: number;
  unsubscribe: () => void;
  abortCleanup?: () => void;
  disposePromise?: Promise<void>;
  sessionPath?: string;
  /** Accepted followUp continuations that have not gone idle yet. */
  pendingMail: number;
  /** True once any inbound mail was accepted on this run. */
  mailAccepted: boolean;
}

export class SubsessionManager {
  private activeSessions = new Map<string, ChildSession>();
  private activeHandles = new Map<string, MinionSessionHandle>();
  private children = new Map<string, ChildRecord>();
  private terminals = new Map<string, ChildTerminalEvent>();
  private terminalWinners = new Map<string, TerminalWinner>();
  private metadataCache = new Map<string, MinionSessionMetadata>();
  private unsubscribers = new Map<string, () => void>();
  private shutdown = false;
  private pendingAborts = new Set<string>();
  private sessionPaths = new Map<string, string>();
  private readonly createChildRuntime: CreateChildRuntime;

  constructor(
    private cwd: string,
    private parentSessionPath: string,
    public readonly eventBus?: EventBus,
    options?: { createChildRuntime?: CreateChildRuntime },
  ) {
    this.createChildRuntime = options?.createChildRuntime ?? defaultCreateChildRuntime;
  }

  /** Emit progress events via EventBus for parent to receive */
  private emitProgress(id: string, progress: unknown): void {
    this.eventBus?.emit(MINION_PROGRESS_CHANNEL, { id, progress });
  }

  /**
   * Compatibility wrapper: start the child without waiting for terminal.
   * Prefer `startChild()` + `handle.wait()`.
   */
  async create(options: CreateMinionSessionOptions): Promise<MinionSessionHandle> {
    return this.startChild(options);
  }

  /**
   * Start a child session and return a handle without awaiting completion.
   * Foreground spawn waits via `handle.wait()`; orchestrate does not.
   */
  async startChild(options: CreateMinionSessionOptions): Promise<MinionSessionHandle> {
    if (this.shutdown) {
      throw new Error("SubsessionManager is shut down; further start is rejected");
    }

    const { id, name, task, config, spawnedBy, signal } = options;
    if (this.consumePendingAbort(id) || this.terminals.has(id)) {
      return this.finishAbortedStart(id);
    }
    if (this.activeHandles.has(id) && !this.terminals.has(id)) {
      throw new Error(`Child ${id} is already running`);
    }

    const minionsDir = getMinionsDir(this.cwd);
    mkdirSync(minionsDir, { recursive: true });

    const metadata: MinionSessionMetadata = {
      sessionId: id,
      parentSession: this.parentSessionPath,
      spawnedBy,
      name,
      task,
      agent: config.name,
      createdAt: Date.now(),
      status: "running",
    };

    const { runtime, sessionPath } = await this.createChildRuntime({
      cwd: options.cwd || this.cwd,
      id,
      name,
      config,
      parentModel: options.parentModel,
      parentSystemPrompt: options.parentSystemPrompt,
      customTools: options.customTools,
    });
    const session = runtime.session;
    this.rememberSessionPath(id, sessionPath);
    await this.rejectStartIfShutdown(id, runtime);
    if (this.consumePendingAbort(id) || this.terminals.has(id)) {
      return this.finishAbortedStart(id, sessionPath, runtime);
    }

    if (config.thinking) session.setThinkingLevel(config.thinking);

    this.metadataCache.set(id, metadata);
    this.writeMetadataFile(sessionPath, metadata);

    const child: ChildRecord = {
      id,
      runtime,
      session,
      options,
      abortRequested: false,
      waiters: [],
      currentFullText: "",
      turnCount: 0,
      unsubscribe: () => {},
      pendingMail: 0,
      mailAccepted: false,
      sessionPath,
    };
    this.children.set(id, child);
    this.activeSessions.set(id, session);

    await session.bindExtensions({
      shutdownHandler: () => {
        this.abortChild(id);
      },
    });
    await this.rejectStartIfShutdown(id);
    if (this.consumePendingAbort(id) || this.terminals.has(id) || child.terminal) {
      return this.finishAbortedStart(id, sessionPath);
    }
    this.applyTools(id);

    if (options.toolSyncEnabled !== false) {
      await this.waitForAsyncTools(id, session, options.parentToolNames, options.toolSyncMaxWait);
      await this.rejectStartIfShutdown(id);
      if (this.consumePendingAbort(id) || this.terminals.has(id) || child.terminal) {
        return this.finishAbortedStart(id, sessionPath);
      }
      this.applyTools(id);
    }

    // Latch shutdown / terminal before publishing so disposeAll during
    // waitForAsyncTools cannot resurrect a dropped handle.
    const pendingAbort = this.consumePendingAbort(id);
    if (this.shutdown || child.terminal || this.terminals.has(id) || pendingAbort) {
      this.activeHandles.delete(id);
      if (this.shutdown) {
        this.abortChild(id);
        await this.disposeChild(id);
        throw new Error("SubsessionManager is shut down; further start is rejected");
      }
      if (pendingAbort && !child.terminal) {
        this.abortChild(id);
      }
      await this.disposeChild(id);
      logger.debug("subsession", "created-aborted", { id, name, path: sessionPath });
      return this.buildHandle(id, sessionPath);
    }

    const unsubscribe = session.subscribe((event) => this.handleChildEvent(id, event));
    child.unsubscribe = unsubscribe;
    this.unsubscribers.set(id, unsubscribe);

    const handle = this.buildHandle(id, sessionPath);
    this.activeHandles.set(id, handle);

    if (signal) {
      const onAbort = () => this.abortChild(id);
      if (signal.aborted) {
        this.abortChild(id);
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        child.abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }
    }

    // Halt may have recorded a pending abort in the gap before the handle was published.
    if (this.consumePendingAbort(id) || child.terminal) {
      this.abortChild(id);
      this.activeHandles.delete(id);
      logger.debug("subsession", "created-aborted", { id, name, path: sessionPath });
      return handle;
    }

    // Start without awaiting. Terminal is committed on agent_settled / abort / prompt failure,
    // not on the first agent_end (retries, compaction, follow-ups may continue).
    session
      .prompt(task)
      .then(async () => {
        if (this.terminals.has(id)) return;
        try {
          await session.waitForIdle();
        } catch {
          // waitForIdle is best-effort; agent_settled is the primary idle signal.
        }
        await this.drainTrailingSessionEvents(id, session);
        const record = this.children.get(id);
        if (!record || record.terminal) return;
        if (record.abortRequested) {
          this.commitTerminal(id, this.makeTerminal(record, "aborted"));
          return;
        }
        if (record.pendingFailure) {
          this.commitTerminal(id, this.makeTerminal(record, "failed", record.pendingFailure));
          return;
        }
        this.tryCommitIdle(id);
      })
      .catch((err) => {
        const record = this.children.get(id);
        if (!record || record.terminal) return;
        if (record.abortRequested) {
          this.commitTerminal(id, this.makeTerminal(record, "aborted"));
          return;
        }
        const error = err instanceof Error ? err.message : String(err);
        this.commitTerminal(id, this.makeTerminal(record, "failed", error));
      });

    logger.debug("subsession", "started", { id, name, path: sessionPath });
    return handle;
  }

  waitForChild(id: string): Promise<ChildTerminalEvent> {
    const existing = this.terminals.get(id);
    if (existing) return Promise.resolve(existing);
    const child = this.children.get(id);
    if (!child) {
      return Promise.reject(new Error(`Unknown child ${id}`));
    }
    if (child.terminal) return Promise.resolve(child.terminal);
    return new Promise((resolve) => {
      child.waiters.push(resolve);
    });
  }

  /**
   * Single-flight terminal latch. First caller wins so later mail/settle
   * share one winner. Returns true if this caller committed.
   */
  commitTerminal(id: string, event: ChildTerminalEvent): boolean {
    if (this.terminals.has(id)) {
      logger.info("subsession", "lifecycle", {
        childId: id,
        eventClass: event.class,
        terminalLatchFired: false,
        winner: this.terminalWinners.get(id),
        terminalEventCount: 1,
      });
      return false;
    }

    const child = this.children.get(id);
    const winner = this.inferWinner(child, event);
    this.terminals.set(id, event);
    this.terminalWinners.set(id, winner);
    if (child) child.terminal = event;

    const metadataStatus: MinionSessionMetadata["status"] =
      event.class === "settled" ? "completed" : event.class;
    this.updateStatus(id, metadataStatus, event.exitCode, event.error);

    child?.options.onComplete?.({
      exitCode: event.exitCode,
      output: event.output,
      status: metadataStatus,
      error: event.error,
    });
    this.eventBus?.emit(MINION_COMPLETE_CHANNEL, {
      id,
      exitCode: event.exitCode,
      output: event.output,
      error: event.error,
      class: event.class,
    });

    for (const resolve of child?.waiters ?? []) resolve(event);
    if (child) child.waiters = [];

    logger.info("subsession", "lifecycle", {
      childId: id,
      eventClass: event.class,
      terminalLatchFired: true,
      winner,
      terminalEventCount: 1,
    });

    void this.disposeChild(id);
    return true;
  }

  getTerminal(id: string): ChildTerminalEvent | undefined {
    return this.terminals.get(id);
  }

  isLive(id: string): boolean {
    return this.activeHandles.has(id) && !this.terminals.has(id) && !this.shutdown;
  }

  /** Re-apply the child tool formula. Call after late-registered tools. */
  applyTools(id: string): string[] {
    const child = this.children.get(id);
    if (!child) return [];
    const names = applyChildToolAllowlist(child.session, {
      roleAllowlist: child.options.config.tools,
      parentCodingTools: child.options.parentToolNames,
      extraTools: child.options.extraTools,
    });
    logger.info("subsession", "tools-filtered", { childId: id, tools: names });
    return names;
  }

  /**
   * Parent session_shutdown (quit, /new, resume, fork, reload) aborts and
   * disposes every live child. Further start/mail is rejected.
   */
  async disposeAll(): Promise<void> {
    this.shutdown = true;
    const ids = [...this.children.keys()];
    for (const id of ids) {
      this.abortChild(id);
      await this.disposeChild(id);
    }
  }

  abortSession(id: string): boolean {
    const handle = this.activeHandles.get(id);
    if (handle) {
      this.pendingAborts.delete(id);
      handle.abort();
      return true;
    }
    if (this.children.has(id)) {
      this.pendingAborts.delete(id);
      this.abortChild(id);
      return true;
    }
    this.pendingAborts.add(id);
    return true;
  }

  private consumePendingAbort(id: string): boolean {
    return this.pendingAborts.delete(id);
  }

  private commitSyntheticAbort(id: string): void {
    if (this.terminals.has(id)) return;
    this.terminals.set(id, { class: "aborted", exitCode: 1, output: "" });
    this.terminalWinners.set(id, "abort");
  }

  private async finishAbortedStart(
    id: string,
    sessionPath = "",
    runtime?: ChildRuntime,
  ): Promise<MinionSessionHandle> {
    this.rememberSessionPath(id, sessionPath);
    this.pendingAborts.delete(id);
    this.activeHandles.delete(id);
    if (this.children.has(id)) {
      this.abortChild(id);
      await this.disposeChild(id);
    } else {
      if (runtime) {
        try {
          await runtime.dispose();
        } catch {
          /* ignore */
        }
      }
      this.commitSyntheticAbort(id);
    }
    logger.debug("subsession", "created-aborted", { id, path: sessionPath });
    return this.buildHandle(id, sessionPath);
  }

  private requireLiveSession(id: string): ChildSession {
    if (this.shutdown || this.terminals.has(id) || !this.activeHandles.has(id)) {
      throw new Error(`Child ${id} is terminal; further mail is rejected`);
    }
    const session = this.activeSessions.get(id);
    if (!session) {
      throw new Error(`Child ${id} is terminal; further mail is rejected`);
    }
    return session;
  }

  /**
   * Accept inbound followUp against the terminal latch. Sync so a later
   * settle in this turn cannot commit while mail is already accepted.
   */
  private acceptMail(id: string): ChildSession {
    const session = this.requireLiveSession(id);
    const child = this.children.get(id);
    if (child) {
      child.pendingMail += 1;
      child.mailAccepted = true;
    }
    return session;
  }

  private releaseMail(id: string): void {
    const child = this.children.get(id);
    if (!child) return;
    if (child.pendingMail > 0) child.pendingMail -= 1;
    if (child.pendingMail === 0) this.tryCommitIdle(id);
  }

  /**
   * Happy-path settle only. Abort/fail/shutdown commit immediately through
   * the same latch. Pending accepted mail postpones settle until idle.
   */
  private tryCommitIdle(id: string): void {
    const record = this.children.get(id);
    if (!record || record.terminal || this.terminals.has(id)) return;
    if (record.pendingMail > 0) {
      logger.info("subsession", "lifecycle", {
        childId: id,
        eventClass: "mail-then-settle",
        terminalLatchFired: false,
        winner: "mail-then-settle",
      });
      return;
    }
    if (record.abortRequested) {
      this.commitTerminal(id, this.makeTerminal(record, "aborted"));
      return;
    }
    if (record.pendingFailure) {
      this.commitTerminal(id, this.makeTerminal(record, "failed", record.pendingFailure));
      return;
    }
    this.commitTerminal(id, this.makeTerminal(record, "settled"));
  }

  private inferWinner(child: ChildRecord | undefined, event: ChildTerminalEvent): TerminalWinner {
    if (this.shutdown) return "shutdown";
    if (event.class === "aborted") return "abort";
    if (event.class === "failed") return "fail";
    if (child?.mailAccepted) return "mail-then-settle";
    return "settle";
  }

  private buildHandle(id: string, path: string): MinionSessionHandle {
    return {
      id,
      path,
      steer: async (text: string) => {
        await this.requireLiveSession(id).steer(text);
      },
      followUp: async (text: string) => {
        const session = this.acceptMail(id);
        try {
          await session.followUp(text);
          try {
            await session.waitForIdle();
          } catch {
            // waitForIdle is best-effort; agent_settled is the primary idle signal.
          }
          await this.drainTrailingSessionEvents(id, session);
        } finally {
          this.releaseMail(id);
        }
      },
      abort: () => {
        this.abortChild(id);
      },
      wait: () => this.waitForChild(id),
    };
  }

  private abortChild(id: string): void {
    const child = this.children.get(id);
    if (!child) return;
    child.abortRequested = true;
    // Abort before dispose so prompt/idle latches resolve. Skip abort if
    // dispose already started — abort after dispose is a no-op or hangs.
    if (!child.disposePromise) {
      try {
        child.session.abortBash?.();
      } catch {
        /* unmanaged processes cannot be guaranteed */
      }
      try {
        void child.session.abort();
      } catch {
        /* ignore */
      }
    }
    this.commitTerminal(id, this.makeTerminal(child, "aborted"));
  }

  private disposeChild(id: string): Promise<void> {
    const child = this.children.get(id);
    if (!child) {
      this.activeHandles.delete(id);
      this.activeSessions.delete(id);
      return Promise.resolve();
    }
    if (child.disposePromise) return child.disposePromise;

    child.disposePromise = this.runDisposeChild(id, child);
    return child.disposePromise;
  }

  private async runDisposeChild(id: string, child: ChildRecord): Promise<void> {
    child.unsubscribe();
    this.unsubscribers.delete(id);
    child.abortCleanup?.();
    this.activeSessions.delete(id);
    this.activeHandles.delete(id);

    try {
      child.session.abortBash?.();
    } catch {
      /* unmanaged processes cannot be guaranteed */
    }
    try {
      await child.runtime.dispose();
    } catch {
      try {
        child.session.dispose();
      } catch {
        /* ignore */
      }
    }

    this.children.delete(id);
  }

  /**
   * After every await in startChild: if session_shutdown raced in, do not
   * publish a handle. Further start stays rejected.
   */
  private async rejectStartIfShutdown(id: string, runtime?: ChildRuntime): Promise<void> {
    if (!this.shutdown) return;
    this.activeHandles.delete(id);
    if (this.children.has(id)) {
      this.abortChild(id);
      await this.disposeChild(id);
    } else if (runtime) {
      try {
        await runtime.dispose();
      } catch {
        /* ignore */
      }
    }
    throw new Error("SubsessionManager is shut down; further start is rejected");
  }

  private handleChildEvent(id: string, event: ChildSessionEvent): void {
    const child = this.children.get(id);
    if (!child || child.terminal) return;

    this.emitProgress(id, event);

    if (event.type === "tool_execution_start" && event.toolName) {
      child.options.onToolActivity?.({
        type: "start",
        toolName: event.toolName,
        args: event.args,
      });
    }
    if (event.type === "tool_execution_end" && event.toolName) {
      child.options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "tool_execution_update" && event.toolName && child.options.onToolOutput) {
      const fullText = event.partialResult?.content?.[0]?.text ?? "";
      child.options.onToolOutput(event.toolName, fullText);
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta ?? "";
      child.currentFullText += delta;
      child.options.onTextDelta?.(delta, child.currentFullText);
    }
    if (event.type === "turn_end") {
      child.turnCount++;
      child.options.onTurnEnd?.(child.turnCount);
      if (child.options.onUsageUpdate) {
        try {
          const stats = child.session.getSessionStats();
          child.options.onUsageUpdate({
            input: stats.tokens.input,
            output: stats.tokens.output,
            cacheRead: stats.tokens.cacheRead,
            cacheWrite: stats.tokens.cacheWrite,
            cost: stats.cost,
          });
        } catch {
          // getSessionStats may not be available in all states
        }
      }
    }
    if (event.type === "auto_retry_end" && event.success === false) {
      child.pendingFailure = event.finalError ?? "provider error";
    }

    const eventClass =
      event.type === "agent_settled"
        ? child.abortRequested
          ? "aborted"
          : child.pendingFailure
            ? "failed"
            : "settled"
        : event.type;

    if (event.type === "agent_end") {
      // First agent_end is too early: retries, compaction, and queued continuations
      // may still run. Wait for agent_settled / waitForIdle.
      logger.info("subsession", "lifecycle", {
        childId: id,
        eventClass: "agent_end",
        terminalLatchFired: false,
        willRetry: event.willRetry === true,
      });
      return;
    }

    if (event.type === "agent_settled") {
      if (child.abortRequested) {
        this.commitTerminal(id, this.makeTerminal(child, "aborted"));
        return;
      }
      if (child.pendingFailure) {
        this.commitTerminal(id, this.makeTerminal(child, "failed", child.pendingFailure));
        return;
      }
      this.tryCommitIdle(id);
      return;
    }

    logger.debug("subsession", "lifecycle", {
      childId: id,
      eventClass,
      terminalLatchFired: false,
    });
  }

  private makeTerminal(
    child: ChildRecord,
    terminalClass: ChildTerminalEvent["class"],
    error?: string,
  ): ChildTerminalEvent {
    const output = extractLastAssistantText(child.session.state.messages) || child.currentFullText;
    return {
      class: terminalClass,
      exitCode: terminalClass === "settled" ? 0 : 1,
      output,
      error: terminalClass === "failed" ? error : terminalClass === "aborted" ? error : undefined,
    };
  }

  /**
   * prompt()/waitForIdle() can resolve before AgentSession finishes dispatching
   * turn_end, agent_settled, and auto_retry_end. Drain those before commit so
   * trailing usage and retry failures are not dropped. Bounded: never hang if
   * agent_settled never arrives.
   */
  private async drainTrailingSessionEvents(id: string, session: ChildSession): Promise<void> {
    const host = session as ChildSession & { _agentEventQueue?: Promise<void> };
    if (host._agentEventQueue) {
      for (let i = 0; i < SESSION_EVENT_QUEUE_DRAIN_LIMIT; i++) {
        const before: Promise<void> | undefined = host._agentEventQueue;
        if (!before) break;
        await before;
        if (host._agentEventQueue === before) break;
      }
    }

    for (let i = 0; i < TRAILING_EVENT_MICROTASK_BUDGET; i++) {
      await Promise.resolve();
      const record = this.children.get(id);
      if (!record || record.terminal || this.terminals.has(id)) return;
      if (record.abortRequested || record.pendingFailure) return;
    }
  }

  private async waitForAsyncTools(
    id: string,
    session: ChildSession,
    parentToolNames?: string[],
    maxWait?: number,
  ): Promise<void> {
    if (!parentToolNames) return;

    const expected = parentToolNames.filter((name) => !SubsessionManager.BUILTIN_TOOLS.has(name));
    if (expected.length === 0) return;

    const POLL_INTERVAL = 200;
    const effectiveMaxWait = maxWait ?? 5000;
    const deadline = Date.now() + effectiveMaxWait;

    while (Date.now() < deadline) {
      if (
        this.shutdown ||
        this.terminals.has(id) ||
        this.children.get(id)?.terminal ||
        this.pendingAborts.has(id)
      )
        return;
      let current: Set<string>;
      try {
        current = new Set(session.getAllTools().map((t) => t.name));
      } catch {
        return;
      }
      const missing = expected.filter((name) => !current.has(name));
      if (missing.length === 0) {
        logger.debug("subsession", "async-tools-ready", {
          id,
          waited: effectiveMaxWait - (deadline - Date.now()),
          toolCount: current.size,
        });
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      if (
        this.shutdown ||
        this.terminals.has(id) ||
        this.children.get(id)?.terminal ||
        this.pendingAborts.has(id)
      )
        return;
    }

    if (this.shutdown || this.terminals.has(id) || this.children.get(id)?.terminal) return;

    let current: Set<string>;
    try {
      current = new Set(session.getAllTools().map((t) => t.name));
    } catch {
      return;
    }
    const stillMissing = expected.filter((name) => !current.has(name));
    if (stillMissing.length > 0) {
      logger.info("subsession", "async-tools-timeout", {
        id,
        missing: stillMissing,
        missingCount: stillMissing.length,
        maxWait: effectiveMaxWait,
      });
    }
  }

  private static readonly BUILTIN_TOOLS = new Set([
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "spawn",
    "list_agents",
    "halt",
    "list_minion_types",
    "list_minions",
    "show_minion",
    "learn_minions",
    "orchestrate",
    ...PARENT_ONLY_MINION_TOOLS,
  ]);

  private getMetadata(id: string): MinionSessionMetadata | undefined {
    // Check cache first
    if (this.metadataCache.has(id)) {
      return this.metadataCache.get(id);
    }

    const sessionPath = this.lookupSessionPath(id);
    if (!sessionPath) return undefined;
    const metadata = this.readMetadataFile(sessionPath);
    if (metadata) this.metadataCache.set(id, metadata);
    return metadata;
  }

  list(): MinionSessionMetadata[] {
    const minionsDir = getMinionsDir(this.cwd);
    if (!existsSync(minionsDir)) {
      return [];
    }

    const files = this.listSessionFiles(minionsDir);
    const results: MinionSessionMetadata[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      const metadata = this.readMetadataFile(join(minionsDir, file));
      if (metadata) {
        results.push(metadata);
        seen.add(metadata.sessionId);
      }
    }

    for (const file of this.listLinkFiles(minionsDir)) {
      const link = this.readLinkFile(join(minionsDir, file));
      if (!link) continue;
      const metadata = this.readMetadataFile(link.sessionPath);
      if (!metadata || seen.has(metadata.sessionId)) continue;
      this.rememberSessionPath(metadata.sessionId, link.sessionPath);
      results.push(metadata);
      seen.add(metadata.sessionId);
    }

    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  getSession(id: string): ChildSession | undefined {
    return this.activeSessions.get(id);
  }

  getSessionHandle(id: string): MinionSessionHandle | undefined {
    return this.activeHandles.get(id);
  }

  /** Check if a session path is a minion session and return the minion ID */
  getMinionIdFromPath(sessionPath: string): string | undefined {
    logger.debug("subsession", "getMinionIdFromPath-start", { sessionPath });
    for (const [id, path] of this.sessionPaths) {
      if (path === sessionPath) {
        logger.debug("subsession", "extracted-id", { sessionPath, id });
        return id;
      }
    }
    const minionsDir = getMinionsDir(this.cwd);
    logger.debug("subsession", "checking-minions-dir", {
      sessionPath,
      minionsDir,
      startsWith: sessionPath.startsWith(minionsDir),
    });
    if (!sessionPath.startsWith(minionsDir)) {
      const linkedId = this.findLinkedMinionId(sessionPath);
      if (linkedId) {
        logger.debug("subsession", "extracted-id", { sessionPath, id: linkedId });
        this.rememberSessionPath(linkedId, sessionPath);
        return linkedId;
      }
      logger.debug("subsession", "not-minions-dir", {
        sessionPath,
        minionsDir,
      });
      return undefined;
    }
    // Read metadata to get the session ID
    const metadata = this.readMetadataFile(sessionPath);
    logger.debug("subsession", "read-metadata-result", {
      sessionPath,
      hasMetadata: !!metadata,
    });
    if (metadata) {
      logger.debug("subsession", "extracted-id", {
        sessionPath,
        id: metadata.sessionId,
      });
      this.rememberSessionPath(metadata.sessionId, sessionPath);
      return metadata.sessionId;
    }
    logger.debug("subsession", "no-metadata-returning-undefined", {
      sessionPath,
    });
    return undefined;
  }

  /** Get the session file path for a minion by ID */
  getSessionPath(id: string): string | undefined {
    const stored = this.lookupSessionPath(id);
    if (stored) {
      logger.debug("subsession", "found-session-path", { id, path: stored });
      return stored;
    }
    logger.debug("subsession", "session-path-not-found", { id });
    return undefined;
  }

  /** Get metadata for a minion session by ID */
  getCurrentMetadata(): MinionSessionMetadata | undefined {
    // This is used when we're in a minion session to get its metadata
    const metadata = this.list();
    // Return the most recently created running minion as current
    return metadata.find((m) => m.status === "running");
  }

  updateStatus(
    id: string,
    status: MinionSessionMetadata["status"],
    exitCode?: number,
    error?: string,
  ): void {
    const metadata = this.metadataCache.get(id) ?? this.getMetadata(id);
    if (metadata) {
      metadata.status = status;
      if (exitCode !== undefined) metadata.exitCode = exitCode;
      if (error !== undefined) metadata.error = error;

      const sessionPath = this.lookupSessionPath(id);
      if (sessionPath) this.writeMetadataFile(sessionPath, metadata);

      this.metadataCache.set(id, metadata);
    }
  }

  parseSessionHistory(id: string): string[] {
    const path = this.getSessionPath(id);
    if (!path) return [];
    const history: string[] = [];
    let turnCount = 0;
    try {
      for (const raw of readFileSync(path, "utf-8").split("\n")) {
        if (!raw.trim()) continue;
        const event = JSON.parse(raw) as Record<string, unknown>;
        if (event.type === "tool_execution_start") {
          const args = (event.args ?? {}) as Record<string, unknown>;
          history.push(`→ ${formatToolCall(String(event.toolName), args)}`);
        } else if (event.type === "turn_end") {
          turnCount++;
          history.push(`turn ${turnCount}`);
        }
      }
    } catch {
      /* ignore */
    }
    return history;
  }

  private rememberSessionPath(id: string, sessionPath: string): void {
    if (!id || !sessionPath) return;
    this.sessionPaths.set(id, sessionPath);
  }

  private lookupSessionPath(id: string): string | undefined {
    const stored = this.sessionPaths.get(id);
    if (stored) return stored;
    const minionsDir = getMinionsDir(this.cwd);
    for (const file of this.listSessionFiles(minionsDir)) {
      const sessionPath = join(minionsDir, file);
      const metadata = this.readMetadataFile(sessionPath);
      if (metadata?.sessionId === id) {
        this.rememberSessionPath(id, sessionPath);
        return sessionPath;
      }
    }
    const link = this.readLinkFile(this.getLinkPath(id));
    if (link) {
      this.rememberSessionPath(id, link.sessionPath);
      return link.sessionPath;
    }
    return undefined;
  }

  private listSessionFiles(dir: string): string[] {
    try {
      return readdirSync(dir).filter((f: string) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
  }

  private listLinkFiles(dir: string): string[] {
    try {
      return readdirSync(dir).filter((f: string) => f.endsWith(".minion-link.json"));
    } catch {
      return [];
    }
  }

  private getLinkPath(id: string): string {
    return join(getMinionsDir(this.cwd), `${id}.minion-link.json`);
  }

  private isForeignSessionPath(sessionPath: string): boolean {
    return dirname(sessionPath) !== getMinionsDir(this.cwd);
  }

  private syncLinkFile(id: string, sessionPath: string): void {
    if (!this.isForeignSessionPath(sessionPath)) return;
    const minionsDir = getMinionsDir(this.cwd);
    mkdirSync(minionsDir, { recursive: true });
    writeFileSync(this.getLinkPath(id), JSON.stringify({ sessionPath }, null, 2));
  }

  private readLinkFile(linkPath: string): { sessionPath: string } | undefined {
    try {
      if (!existsSync(linkPath)) return undefined;
      const parsed = JSON.parse(readFileSync(linkPath, "utf-8")) as {
        sessionPath?: unknown;
      };
      if (typeof parsed.sessionPath === "string" && parsed.sessionPath.length > 0) {
        return { sessionPath: parsed.sessionPath };
      }
    } catch {
      /* ignore corrupt/missing link files */
    }
    return undefined;
  }

  private findLinkedMinionId(sessionPath: string): string | undefined {
    const minionsDir = getMinionsDir(this.cwd);
    if (!existsSync(minionsDir)) return undefined;
    for (const file of this.listLinkFiles(minionsDir)) {
      const link = this.readLinkFile(join(minionsDir, file));
      if (link?.sessionPath !== sessionPath) continue;
      const metadata = this.readMetadataFile(sessionPath);
      if (metadata?.sessionId) return metadata.sessionId;
      return file.replace(/\.minion-link\.json$/, "");
    }
    return undefined;
  }

  /** Get metadata file path for a session file */
  private getMetadataPath(sessionPath: string): string {
    return `${sessionPath}.minion-meta.json`;
  }

  /** Write metadata to separate file (don't modify pi's session file) */
  private writeMetadataFile(sessionPath: string, metadata: MinionSessionMetadata): void {
    try {
      const metaPath = this.getMetadataPath(sessionPath);
      writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
      this.syncLinkFile(metadata.sessionId, sessionPath);
      logger.debug("subsession", "metadata-written", { sessionPath, metaPath });
    } catch (err) {
      logger.debug("subsession", "metadata-write-error", {
        sessionPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Read metadata from separate file, with fallback to legacy format in session file */
  private readMetadataFile(sessionPath: string): MinionSessionMetadata | undefined {
    try {
      // Try new format first: separate metadata file
      const metaPath = this.getMetadataPath(sessionPath);
      if (existsSync(metaPath)) {
        const content = readFileSync(metaPath, "utf-8");
        const metadata = JSON.parse(content) as MinionSessionMetadata;
        logger.debug("subsession", "metadata-read", {
          sessionPath,
          metaPath,
          id: metadata.sessionId,
        });
        return metadata;
      }

      // Fallback to legacy format: metadata embedded in session file first line
      if (existsSync(sessionPath)) {
        const content = readFileSync(sessionPath, "utf-8");
        const firstLine = content.split("\n")[0];
        if (firstLine) {
          const parsed = JSON.parse(firstLine);
          if (parsed.__metadata) {
            logger.debug("subsession", "metadata-read-legacy", {
              sessionPath,
              id: parsed.__metadata.sessionId,
            });
            return parsed.__metadata as MinionSessionMetadata;
          }
        }
      }

      logger.debug("subsession", "metadata-file-not-found", {
        sessionPath,
        metaPath,
      });
      return undefined;
    } catch (err) {
      logger.debug("subsession", "metadata-read-error", {
        sessionPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** Load session info using SessionManager.list() - proper API usage */
  async loadSessionInfo(): Promise<void> {
    const minionsDir = getMinionsDir(this.cwd);
    try {
      const sessions = await SessionManager.list(this.cwd, minionsDir);
      logger.debug("subsession", "loaded-session-list", {
        count: sessions.length,
      });
      for (const session of sessions) {
        logger.debug("subsession", "session-info", {
          path: session.path,
          id: session.id,
          name: session.name,
          parentSessionPath: session.parentSessionPath,
        });
      }
    } catch (err) {
      logger.debug("subsession", "load-session-list-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function extractLastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown> | undefined;
    if (msg?.role !== "assistant") continue;

    const content = msg.content;
    if (typeof content === "string") return content.trim();

    if (Array.isArray(content)) {
      const text = content
        .filter((b: { type: string; text?: string }) => b.type === "text" && b.text)
        .map((b: { type: string; text?: string }) => b.text ?? "")
        .join("");
      if (text.trim()) return text.trim();
    }
  }
  return "";
}
