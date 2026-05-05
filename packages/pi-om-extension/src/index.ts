import type { Message } from "@mariozechner/pi-ai";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AuthResolver } from "./agents.js";
import { ObservationAgents } from "./agents.js";
import { loadConfig, sessionStatePath } from "./config.js";
import {
  buildObservationContext,
  buildStoredObservationBlock,
  ensureToolCallPairing,
  evaluateObservationTrigger,
  getMessagesBetweenCursors,
  getObservationChunk,
  getObservationTriggerThresholds,
  getPublishedObservationState,
  getUnobservedMessages,
  preservePreviousAssistantResponse,
  runObservationCycle,
} from "./engine.js";
import {
  formatObservationsReport,
  formatStatusReport,
  OM_COMMAND_USAGE,
  type OMStatusReport,
} from "./format.js";
import { loadSessionState, saveSessionState } from "./state.js";
import { countMessageTokens, summarizeMessageWindow } from "./tokens.js";
import type { OMConfig } from "./types.js";

/**
 * Load the merged OM config for a given cwd. Exposed so host runtimes
 * (e.g. a host runtime) can log the resolved config at
 * startup to verify env vars and JSON overrides landed as expected.
 * Same resolution chain the extension itself uses at session_start.
 */
export { loadConfig } from "./config.js";
export type { CursorMode, CycleReason, ObserverResult, OMConfig, SessionState } from "./types.js";

function debugLog(config: OMConfig, message: string, details?: Record<string, unknown>): void {
  if (!config.debug) return;
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.error(`[om:ext] ${message}${payload}`);
}

/**
 * Pi coding-agent extension for observational memory.
 *
 * Hooks into the agent lifecycle to:
 * 1. Observe conversation history and extract dense observations via LLM
 * 2. Reflect/consolidate when observations grow too large
 * 3. Prune raw message history and inject observation context before each LLM call
 * 4. Force a final observation pass before compaction
 */
export default function piObservationalMemory(pi: ExtensionAPI) {
  let config: OMConfig | undefined;
  let agents: ObservationAgents | undefined;

  // Instance-scoped deduplication map for concurrent observation cycles
  const inflight = new Map<string, Promise<void>>();

  function ensureInitialized(ctx: ExtensionContext): {
    config: OMConfig;
    agents: ObservationAgents;
  } {
    if (!config || !agents) {
      config = loadConfig(ctx.cwd);
      // Use pi's ModelRegistry as our auth resolver — this gives the observer
      // and reflector access to the same auth.json / env var resolution chain
      // that the agent itself uses, including OAuth refresh.
      const resolver: AuthResolver = {
        getApiKeyAndHeaders: (model) => ctx.modelRegistry.getApiKeyAndHeaders(model),
      };
      agents = new ObservationAgents(config, resolver);
    }
    return { config, agents };
  }

  // -------------------------------------------------------------------------
  // session_start — initialize/load state
  // -------------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    const { config: cfg } = ensureInitialized(ctx);
    const sessionId = ctx.sessionManager.getSessionId();

    debugLog(cfg, "session_start", { sessionId });

    const state = await loadSessionState(cfg.storage.stateDir, sessionId);
    await saveSessionState(cfg.storage.stateDir, state);
  });

  // -------------------------------------------------------------------------
  // before_agent_start — inject observation context into system prompt
  // -------------------------------------------------------------------------
  pi.on("before_agent_start", async (event, ctx) => {
    const { config: cfg } = ensureInitialized(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const state = await loadSessionState(cfg.storage.stateDir, sessionId);

    const observationContext = buildObservationContext(getPublishedObservationState(state));
    if (!observationContext) return;

    // Append the segmented observation context to the system prompt. The chaining
    // in pi's extension runner means we receive the current system prompt and
    // return the modified version. Subsequent extensions (if any) will see our
    // modifications.
    debugLog(cfg, "before_agent_start: injecting observations into system prompt", {
      sessionId,
      observationTokens: state.observationTokens,
    });

    return { systemPrompt: `${event.systemPrompt}\n\n${observationContext}` };
  });

  // -------------------------------------------------------------------------
  // context — prune messages to unobserved window before each LLM call
  // -------------------------------------------------------------------------
  pi.on("context", async (event, ctx) => {
    const { config: cfg, agents: agts } = ensureInitialized(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const allMessages = [...event.messages] as Message[];

    debugLog(cfg, "context", {
      sessionId,
      messageCount: allMessages.length,
    });

    // Stage observations incrementally during long runs, but keep the public
    // injected block and pruning cursor frozen until the turn ends. We observe
    // against the full branch so resumed sessions and long tool loops can keep
    // accumulating draft state without mutating the published prompt snapshot.
    await runObservationCycle(cfg, agts, sessionId, getBranchMessages(ctx), inflight, {
      reason: "context",
      publishDraft: false,
      excludeLatestMessage: true,
    });

    // Pruning still uses the published cursor only. Draft observations must never
    // outrun what the model can see in the injected system prompt this turn.
    const state = await loadSessionState(cfg.storage.stateDir, sessionId);

    // Compute the unobserved window
    const unobservedWindow = getUnobservedMessages(
      allMessages,
      state.lastObservedEntryId,
      state.lastObservedTimestamp,
    );

    let boundedMessages = unobservedWindow.messages;
    let cursorMode = unobservedWindow.mode;
    if (boundedMessages.length === 0) {
      const latest = allMessages.at(-1);
      if (latest) {
        boundedMessages = [latest];
        cursorMode = "fallback-latest";
      }
    }

    boundedMessages = preservePreviousAssistantResponse(allMessages, boundedMessages);
    boundedMessages = ensureToolCallPairing(allMessages, boundedMessages);

    // Track pruning metrics
    await saveSessionState(cfg.storage.stateDir, {
      ...state,
      lastCycleAt: Date.now(),
      lastCycleReason: "context",
      lastCursorMode: cursorMode,
      tailEntriesBeforePrune: allMessages.length,
      tailTokensBeforePrune: countMessageTokens(allMessages),
      tailEntriesAfterPrune: boundedMessages.length,
      tailTokensAfterPrune: countMessageTokens(boundedMessages),
      prunedEntriesCount: Math.max(0, allMessages.length - boundedMessages.length),
    });

    debugLog(cfg, "context pruned", {
      sessionId,
      before: allMessages.length,
      after: boundedMessages.length,
    });

    return { messages: boundedMessages };
  });

  // -------------------------------------------------------------------------
  // agent_end — finish the turn with a final observation pass and publish draft state
  // -------------------------------------------------------------------------
  pi.on("agent_end", async (event, ctx) => {
    const { config: cfg, agents: agts } = ensureInitialized(ctx);
    const sessionId = ctx.sessionManager.getSessionId();

    // IMPORTANT: do NOT use `event.messages` here. pi-agent-core's
    // agent_end event is TURN-SCOPED — its `messages` field contains
    // only the messages produced during the current run (user prompt +
    // assistant response + tool calls for this turn). For a resumed
    // session with existing history, that list is always small and
    // never crosses the observation threshold on its own, even when
    // the cumulative session is massively over.
    const messages = getBranchMessages(ctx);

    debugLog(cfg, "agent_end", {
      sessionId,
      messageCount: messages.length,
      turnMessageCount: event.messages.length,
    });

    await runObservationCycle(cfg, agts, sessionId, messages, inflight, {
      reason: "turn_end",
    });
  });

  // -------------------------------------------------------------------------
  // session_before_compact — force observation, inject context into compaction
  // -------------------------------------------------------------------------
  pi.on("session_before_compact", async (event, ctx) => {
    const { config: cfg, agents: agts } = ensureInitialized(ctx);
    const sessionId = ctx.sessionManager.getSessionId();

    debugLog(cfg, "session_before_compact", { sessionId });

    // Extract messages from the branch entries
    const entries = event.branchEntries;
    const messages: Message[] = [];
    for (const entry of entries) {
      if (entry.type === "message") {
        messages.push(entry.message as Message);
      }
    }

    // Force a final observation pass to capture everything before compaction
    await runObservationCycle(cfg, agts, sessionId, messages, inflight, {
      forceObserve: true,
      reason: "compacting",
    });

    // Build a custom compaction that includes observation context in the summary.
    // This ensures the compaction summary benefits from our extracted observations,
    // matching the original opencode behavior where observations were injected
    // into the compaction context.
    const state = await loadSessionState(cfg.storage.stateDir, sessionId);
    const observationContext = buildObservationContext(getPublishedObservationState(state));

    if (observationContext) {
      const { preparation } = event;

      // Build a summary that combines the previous summary (if any) with our
      // observation context. The observation context IS the compressed memory —
      // it's a better summary than what the default LLM compaction would produce
      // from raw messages, since our observer has already extracted the key facts.
      const summaryParts: string[] = [];

      if (preparation.previousSummary) {
        summaryParts.push(preparation.previousSummary);
      }

      summaryParts.push(observationContext);

      return {
        compaction: {
          summary: summaryParts.join("\n\n"),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    }

    // No observations yet — let the default compaction proceed
    return undefined;
  });

  // -------------------------------------------------------------------------
  // session_shutdown — final state persistence
  // -------------------------------------------------------------------------
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!config) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const state = await loadSessionState(config.storage.stateDir, sessionId);
    await saveSessionState(config.storage.stateDir, state);
    debugLog(config, "session_shutdown", { sessionId });
  });

  function getBranchMessages(ctx: ExtensionContext): Message[] {
    const entries = ctx.sessionManager.getBranch();
    const messages: Message[] = [];

    for (const entry of entries) {
      if (entry.type === "message") {
        messages.push(entry.message as Message);
      }
    }

    return messages;
  }

  async function buildStatusSnapshot(
    ctx: ExtensionContext,
    sessionId: string,
  ): Promise<OMStatusReport> {
    const { config: cfg } = ensureInitialized(ctx);
    const statePath = sessionStatePath(cfg.storage.stateDir, sessionId);
    const state = await loadSessionState(cfg.storage.stateDir, sessionId);
    const messages = getBranchMessages(ctx);
    const stageThresholds = getObservationTriggerThresholds(cfg, "stage");
    const publishThresholds = getObservationTriggerThresholds(cfg, "publish");
    const unobservedWindow = getUnobservedMessages(
      messages,
      state.draftLastObservedEntryId,
      state.draftLastObservedTimestamp,
    );
    const unpublishedWindow = getMessagesBetweenCursors(
      messages,
      state.lastObservedEntryId,
      state.lastObservedTimestamp,
      state.draftLastObservedEntryId,
      state.draftLastObservedTimestamp,
    );
    const unobservedStats = summarizeMessageWindow(unobservedWindow.messages);
    const unpublishedStats = summarizeMessageWindow(unpublishedWindow.messages);
    const nextChunkMessages = getObservationChunk(cfg, unobservedWindow.messages);
    const nextChunkStats = summarizeMessageWindow(nextChunkMessages);
    const stageDecision = evaluateObservationTrigger(unobservedStats, stageThresholds);
    const publishDecision = evaluateObservationTrigger(unpublishedStats, publishThresholds);
    return {
      sessionId,
      stateDir: cfg.storage.stateDir,
      statePath,
      observationTokens: state.observationTokens,
      draftObservationTokens: state.draftObservationTokens,
      stagingThreshold: cfg.observation.stageMessageTokens,
      stagingMessageCountThreshold: cfg.observation.stageMessageCount,
      stagingToolResultTokenThreshold: cfg.observation.stageToolResultTokens,
      publishThreshold: cfg.observation.publishMessageTokens,
      publishMessageCountThreshold: cfg.observation.publishMessageCount,
      publishToolResultTokenThreshold: cfg.observation.publishToolResultTokens,
      chunkMessageTokenLimit: cfg.observation.maxChunkMessageTokens,
      chunkMessageLimit: cfg.observation.maxChunkMessages,
      observationModel: `${cfg.observation.provider}/${cfg.observation.modelId}`,
      reflectionThreshold: cfg.reflection.observationTokens,
      reflectionModel: `${cfg.reflection.provider}/${cfg.reflection.modelId}`,
      observationsPresent: Boolean(state.observations.trim()),
      draftObservationsPresent: Boolean(state.draftObservations.trim()),
      lastObservedEntryId: state.lastObservedEntryId ?? null,
      lastObservedTimestamp: state.lastObservedTimestamp
        ? new Date(state.lastObservedTimestamp).toISOString()
        : null,
      draftLastObservedEntryId: state.draftLastObservedEntryId ?? null,
      draftLastObservedTimestamp: state.draftLastObservedTimestamp
        ? new Date(state.draftLastObservedTimestamp).toISOString()
        : null,
      cursorModeForCurrentWindow: unobservedWindow.mode,
      unpublishedCursorModeForCurrentWindow: unpublishedWindow.mode,
      unobservedMessages: unobservedStats.messageCount,
      unobservedMessageTokens: unobservedStats.messageTokens,
      unobservedToolResultCount: unobservedStats.toolResultCount,
      unobservedToolResultTokens: unobservedStats.toolResultTokens,
      unpublishedMessages: unpublishedStats.messageCount,
      unpublishedMessageTokens: unpublishedStats.messageTokens,
      unpublishedToolResultCount: unpublishedStats.toolResultCount,
      unpublishedToolResultTokens: unpublishedStats.toolResultTokens,
      nextChunkMessages: nextChunkStats.messageCount,
      nextChunkMessageTokens: nextChunkStats.messageTokens,
      nextChunkToolResultCount: nextChunkStats.toolResultCount,
      nextChunkToolResultTokens: nextChunkStats.toolResultTokens,
      stagingReasons: [...stageDecision.reasons],
      publishReasons: [...publishDecision.reasons],
      lastCycleAt: state.lastCycleAt ? new Date(state.lastCycleAt).toISOString() : null,
      lastCycleReason: state.lastCycleReason ?? null,
      lastCursorMode: state.lastCursorMode ?? null,
      observeTriggered: state.observeTriggered ?? null,
      publishTriggered: state.publishTriggered ?? null,
      reflectTriggered: state.reflectTriggered ?? null,
      tailEntriesBeforePrune: state.tailEntriesBeforePrune ?? null,
      tailTokensBeforePrune: state.tailTokensBeforePrune ?? null,
      tailEntriesAfterPrune: state.tailEntriesAfterPrune ?? null,
      tailTokensAfterPrune: state.tailTokensAfterPrune ?? null,
      prunedEntriesCount: state.prunedEntriesCount ?? null,
      currentTask: state.currentTask ?? null,
      suggestedResponse: state.suggestedResponse ?? null,
      updatedAt: new Date(state.updatedAt).toISOString(),
    };
  }

  async function buildObservationSections(ctx: ExtensionContext): Promise<string[]> {
    const { config: cfg } = ensureInitialized(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const state = await loadSessionState(cfg.storage.stateDir, sessionId);

    const storedBlock = buildStoredObservationBlock(getPublishedObservationState(state));
    if (!storedBlock) {
      return ["(no observations stored)"];
    }

    return [`<session>${sessionId}</session>`, "", storedBlock];
  }

  // -------------------------------------------------------------------------
  // Slash command
  // -------------------------------------------------------------------------

  pi.registerCommand("om", {
    description: "Inspect observational memory status and stored observations",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0]?.toLowerCase() ?? "status";

      if (parts.length > 1) {
        ctx.ui.notify(OM_COMMAND_USAGE, "info");
        return;
      }

      if (subcommand === "status") {
        const sessionId = ctx.sessionManager.getSessionId();
        const status = await buildStatusSnapshot(ctx, sessionId);
        ctx.ui.notify(formatStatusReport(status), "info");
        return;
      }

      if (subcommand === "observations") {
        const { config: cfg } = ensureInitialized(ctx);
        const sessionId = ctx.sessionManager.getSessionId();
        const state = await loadSessionState(cfg.storage.stateDir, sessionId);
        ctx.ui.notify(formatObservationsReport(state), "info");
        return;
      }

      ctx.ui.notify(OM_COMMAND_USAGE, "info");
    },
  });

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "om_status",
    label: "OM Status",
    description:
      "Show observational memory status for a session, including published vs staged state, thresholds, and cycle history.",
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({ description: "Session ID to query. Defaults to current session." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = params.session_id ?? ctx.sessionManager.getSessionId();
      const status = await buildStatusSnapshot(ctx, sessionId);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "om_observations",
    label: "OM Observations",
    description: "Return the stored observational memory block for the current session.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sections = await buildObservationSections(ctx);

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
        details: undefined,
      };
    },
  });
}
