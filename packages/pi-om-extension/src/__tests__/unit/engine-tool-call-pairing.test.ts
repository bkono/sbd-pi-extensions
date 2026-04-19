import type { Message } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { ensureToolCallPairing } from "../../engine.js";
import { resetMessageCounter, userMsg } from "../helpers/fixtures.js";

function assistantToolCallMessage(
  toolCallId: string,
  opts?: { id?: string; timestamp?: number; text?: string },
): Message {
  return {
    role: "assistant",
    content: [
      ...(opts?.text ? [{ type: "text", text: opts.text }] : []),
      {
        type: "toolCall",
        id: toolCallId,
        toolCallId,
        name: "read",
        toolName: "read",
        arguments: { path: "README.md" },
        input: '{"path":"README.md"}',
      },
    ],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.3-codex",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "tool_use",
    timestamp: opts?.timestamp ?? 1_700_000_000_000,
    id: opts?.id ?? "assistant-tool-call",
  } as unknown as Message;
}

function toolResultMessage(
  toolCallId: string,
  opts?: { id?: string; timestamp?: number; text?: string },
): Message {
  return {
    role: "toolResult",
    toolName: "read",
    toolCallId,
    content: [{ type: "text", text: opts?.text ?? "README contents" }],
    timestamp: opts?.timestamp ?? 1_700_000_001_000,
    id: opts?.id ?? "tool-result",
  } as unknown as Message;
}

describe("ensureToolCallPairing", () => {
  it("returns the selected window unchanged when it already contains the tool call", () => {
    const toolCallId = "call-1";
    const user = userMsg("show me README", 1_700_000_000_000);
    const toolCall = assistantToolCallMessage(toolCallId, {
      id: "assistant-1",
      timestamp: 1_700_000_001_000,
    });
    const result = toolResultMessage(toolCallId, {
      id: "tool-1",
      timestamp: 1_700_000_002_000,
    });
    const messages = [user, toolCall, result];

    expect(ensureToolCallPairing(messages, messages.slice(1))).toEqual(messages.slice(1));
  });

  it("prepends the matching assistant tool call when the window starts at a tool result", () => {
    resetMessageCounter();
    const toolCallId = "call-2";
    const user = userMsg("read README", 1_700_000_000_000);
    const toolCall = assistantToolCallMessage(toolCallId, {
      id: "assistant-2",
      timestamp: 1_700_000_001_000,
    });
    const result = toolResultMessage(toolCallId, {
      id: "tool-2",
      timestamp: 1_700_000_002_000,
    });
    const followup = {
      role: "assistant",
      content: [{ type: "text", text: "README summarized" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1_700_000_003_000,
      id: "assistant-3",
    } as unknown as Message;
    const messages = [user, toolCall, result, followup];

    expect(ensureToolCallPairing(messages, messages.slice(2))).toEqual(messages.slice(1));
  });

  it("keeps the latest tool result paired during latest-message fallback windows", () => {
    resetMessageCounter();
    const toolCallId = "call-3";
    const user = userMsg("read latest file", 1_700_000_000_000);
    const toolCall = assistantToolCallMessage(toolCallId, {
      id: "assistant-4",
      timestamp: 1_700_000_001_000,
    });
    const result = toolResultMessage(toolCallId, {
      id: "tool-3",
      timestamp: 1_700_000_002_000,
    });
    const messages = [user, toolCall, result];

    expect(ensureToolCallPairing(messages, [result])).toEqual(messages.slice(1));
  });
});
