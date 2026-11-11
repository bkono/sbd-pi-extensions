import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { resolveConfig } from "./config.js";
import type { ModelAccess } from "./models.js";
import { recallRange, recallSearch } from "./recall.js";
import { type Host, SessionOM } from "./runtime.js";
import { type ChunkData, renderActiveObservations } from "./state.js";
import { formatStatusReport, registerRenderers } from "./ui.js";

export { resolveConfig } from "./config.js";
export { SessionOM } from "./runtime.js";

const STATUS_KEY = "om";

/**
 * Observational memory for Pi, ported from Mastra Code's OM (`@mastra/memory@1.41.0`).
 * All state lives in the session as `om.*` custom entries plus context edits.
 */
export default function piObservationalMemory(pi: ExtensionAPI): void {
  const config = resolveConfig();
  const sessions = new Map<string, SessionOM>();
  const chunkIndex = new Map<string, ChunkData>();

  function session(ctx: ExtensionContext): SessionOM {
    const id = ctx.sessionManager.getSessionId();
    let om = sessions.get(id);
    if (!om) {
      for (const [otherId, other] of sessions) {
        other.dispose();
        sessions.delete(otherId);
      }
      om = new SessionOM(id, config);
      sessions.set(id, om);
    }
    return om;
  }

  function host(ctx: ExtensionContext): Host {
    return {
      registry: ctx.modelRegistry as unknown as ModelAccess,
      model: ctx.model,
      branch: () => ctx.sessionManager.getBranch(),
      projection: () => ctx.sessionManager.buildSessionProjection().entries,
      isIdle: () => ctx.isIdle(),
      appendEntry: (customType, data) => pi.appendEntry(customType, data),
      setStatus: (text) => ctx.ui.setStatus(STATUS_KEY, text),
      now: () => Date.now(),
    };
  }

  function indexChunks(ctx: ExtensionContext): void {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "om.chunk") {
        const data = entry.data as ChunkData | undefined;
        if (data?.id) chunkIndex.set(data.id, data);
      }
    }
  }

  registerRenderers(pi, (id) => chunkIndex.get(id));

  pi.on("session_start", (_event, ctx) => {
    session(ctx);
    indexChunks(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const om = sessions.get(ctx.sessionManager.getSessionId());
    if (!om) return;
    om.dispose();
    sessions.delete(om.sessionId);
  });

  pi.on("agent_start", (_event, ctx) => {
    session(ctx).startRun(host(ctx));
  });

  pi.on("context", async (_event, ctx) => {
    await session(ctx).onContext(host(ctx));
    return undefined;
  });

  pi.on("context_with_system", (event, ctx) => {
    const messages = session(ctx).onSystem(event.messages as AgentMessage[], host(ctx));
    return messages ? { messages } : undefined;
  });

  pi.on("turn_end", async (event, ctx) => {
    const drafts = await session(ctx).onTurnEnd(
      { contextEntries: event.context.contextEntries },
      host(ctx),
    );
    indexChunks(ctx);
    if (drafts.length === 0) return undefined;
    return { entries: [...event.entries, ...drafts] };
  });

  pi.on("agent_before_settle", (event, ctx) => {
    const drafts = session(ctx).onSettle(
      { contextEntries: event.context.contextEntries },
      host(ctx),
    );
    if (drafts.length === 0) return undefined;
    return { entries: [...event.entries, ...drafts] };
  });

  pi.on("session_tree", (_event, ctx) => {
    session(ctx).onTreeChange(host(ctx));
    indexChunks(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    session(ctx).onCompacted(host(ctx));
    indexChunks(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const result = await session(ctx).onCompact(host(ctx), event.signal);
    indexChunks(ctx);
    if (!result) return undefined;
    return {
      compaction: {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: { observationalMemory: true },
      },
    };
  });

  pi.registerCommand("om", {
    description: "Show observational memory status, or `/om observations` for active memory",
    handler: async (args, ctx) => {
      const om = session(ctx);
      const h = host(ctx);
      if (args.trim() === "observations") {
        const text = renderActiveObservations(om.snapshot(h).state);
        ctx.ui.notify(text || "(no active observations yet)", "info");
        return;
      }
      ctx.ui.notify(formatStatusReport(om.snapshot(h), om.events, om.cacheTtlMs(h)), "info");
    },
  });

  pi.registerTool({
    name: "om_recall",
    label: "Recall history",
    description:
      "Read raw messages from earlier in this session that observational memory has summarized. Pass an observation group `range` (`first:last` entry ids) or a search `query`.",
    parameters: Type.Object({
      range: Type.Optional(
        Type.String({ description: "Observation group range, `firstEntryId:lastEntryId`." }),
      ),
      query: Type.Optional(
        Type.String({ description: "Case-insensitive text to search for in raw history." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch();
      const text = params.range
        ? recallRange(branch, params.range)
        : params.query
          ? recallSearch(branch, params.query)
          : "Pass a `range` from an observation group or a `query`.";
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });
}
