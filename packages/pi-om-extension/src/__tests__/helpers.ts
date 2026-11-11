import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { type SessionBoundaryDraft, SessionManager } from "@earendil-works/pi-coding-agent";

import { type ResolvedOMConfig, resolveConfig } from "../config.js";
import type { ModelAccess } from "../models.js";
import type { Host, SessionOM } from "../runtime.js";
import { countTokens } from "../tokens.js";

export function config(overrides: Partial<ResolvedOMConfig> = {}): ResolvedOMConfig {
  return { ...resolveConfig({}), ...overrides };
}

export function words(count: number): string {
  return "lorem ".repeat(count).trim();
}

let clock = Date.now();
export function tick(ms = 1_000): number {
  clock += ms;
  return clock;
}

export function user(text: string, timestamp = tick()): AgentMessage {
  return { role: "user", content: text, timestamp } as AgentMessage;
}

export function assistantText(
  text: string,
  options: { timestamp?: number; provider?: string } = {},
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: options.provider ?? "openai-codex",
    model: "gpt-6.1-sol",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: options.timestamp ?? tick(),
  } as unknown as AgentMessage;
}

export function assistantToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  options: { timestamp?: number; provider?: string } = {},
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "openai-responses",
    provider: options.provider ?? "openai-codex",
    model: "gpt-6.1-sol",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: options.timestamp ?? tick(),
  } as unknown as AgentMessage;
}

export function toolResult(
  id: string,
  name: string,
  text: string,
  timestamp = tick(),
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  } as unknown as AgentMessage;
}

export function newSession(): SessionManager {
  return SessionManager.inMemory("/tmp/pi-om-test");
}

export function append(session: SessionManager, message: AgentMessage): string {
  return session.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
}

/** Commit boundary drafts the way Pi's `_applyBoundaryDrafts` does. */
export function commit(session: SessionManager, drafts: readonly SessionBoundaryDraft[]): void {
  for (const draft of drafts) {
    if (draft.type === "custom") session.appendCustomEntry(draft.customType, draft.data);
    else if (draft.type === "context_edit")
      session.appendContextEdit(draft.targetId, draft.replacement);
  }
}

export function contextMessages(session: SessionManager): AgentMessage[] {
  return session
    .buildSessionProjection()
    .messages.filter((message) => (message as { role?: string }).role !== "system");
}

export type Responder = (context: Context, model: Model<Api>) => Promise<string> | string;

export const OBSERVATION_RESPONSE = `<observations>
Date: Nov 11, 2026
* 🔴 (10:00) User asked to fix auth bug
* 🟡 (10:01) Agent read src/auth.ts
</observations>

<current-task>
Primary: fix auth bug
</current-task>

<suggested-response>
Continue fixing the auth bug.
</suggested-response>`;

export interface FakeRegistry extends ModelAccess {
  calls: { model: string; system: string; user: string }[];
  respond: Responder;
  auth: Set<string>;
}

export function fakeModel(provider: string, id: string): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 32_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    baseUrl: "",
  } as unknown as Model<Api>;
}

export function fakeRegistry(auth: string[] = ["openai-codex/gpt-6-luna"]): FakeRegistry {
  const registry: FakeRegistry = {
    calls: [],
    respond: () => OBSERVATION_RESPONSE,
    auth: new Set(auth),
    find: (provider, modelId) => fakeModel(provider, modelId),
    hasConfiguredAuth: (model) => registry.auth.has(`${model.provider}/${model.id}`),
    streamSimple: (model, context) => ({
      result: async (): Promise<AssistantMessage> => {
        const userMessage = context.messages[0] as { content: string };
        registry.calls.push({
          model: `${model.provider}/${model.id}`,
          system: context.systemPrompt ?? "",
          user: String(userMessage.content),
        });
        const text = await registry.respond(context, model);
        return {
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
          timestamp: Date.now(),
        } as unknown as AssistantMessage;
      },
    }),
  };
  return registry;
}

export function makeHost(
  session: SessionManager,
  registry: ModelAccess,
  options: { model?: Model<Api>; idle?: boolean; now?: () => number } = {},
): Host & { statuses: (string | undefined)[] } {
  const statuses: (string | undefined)[] = [];
  return {
    registry,
    model: options.model ?? fakeModel("openai-codex", "gpt-6.1-sol"),
    branch: () => session.getBranch(),
    projection: () => session.buildSessionProjection().entries,
    isIdle: () => options.idle ?? false,
    appendEntry: (customType, data) => {
      session.appendCustomEntry(customType, data);
    },
    setStatus: (text) => statuses.push(text),
    now: options.now ?? (() => Date.now()),
    env: {},
    statuses,
  };
}

/** A promise you resolve by hand, for holding observer calls open. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const TOKENS_PER_WORD = countTokens(words(1_000)) / 1_000;
export function textOf(tokens: number): string {
  return words(Math.round(tokens / TOKENS_PER_WORD));
}

let toolSeq = 0;

/** One Pi request: `context`, then `context_with_system`, as Pi's emitContext runs them. */
export async function request(
  om: SessionOM,
  session: SessionManager,
  host: Host,
): Promise<AgentMessage[]> {
  await om.onContext(host);
  const full = [...systemMessages(), ...contextMessages(session)];
  return (om.onSystem(full, host) ?? full).slice(1);
}

/** One agent step: assistant tool call + result, then the turn_end boundary, committed. */
export async function toolStep(
  om: SessionOM,
  session: SessionManager,
  host: Host,
  resultTokens: number,
): Promise<{
  drafts: Awaited<ReturnType<SessionOM["onTurnEnd"]>>;
  resultEntryId: string;
  assistantEntryId: string;
}> {
  await request(om, session, host);
  const id = `call-${++toolSeq}`;
  const assistantEntryId = append(
    session,
    assistantToolCall(id, "read", { path: `src/file-${toolSeq}.ts` }),
  );
  const resultEntryId = append(session, toolResult(id, "read", textOf(resultTokens)));
  const drafts = await om.onTurnEnd(
    { contextEntries: session.buildSessionProjection().entries },
    host,
  );
  commit(session, drafts);
  return { drafts, resultEntryId, assistantEntryId };
}

export function systemMessages(): AgentMessage[] {
  return [{ role: "system", content: "base prompt", timestamp: 0 } as AgentMessage];
}
