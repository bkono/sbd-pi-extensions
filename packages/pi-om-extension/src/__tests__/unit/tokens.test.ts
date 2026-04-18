import type { Message } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  countMessageTokens,
  countTokens,
  selectMessageChunk,
  serializeMessage,
  summarizeMessageWindow,
} from "../../tokens.js";
import {
  assistantMsg,
  conversation,
  resetMessageCounter,
  toolResultMsg,
  userMsg,
} from "../helpers/fixtures.js";

describe("countTokens", () => {
  it("returns 0 for empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  it("returns positive count for non-empty text", () => {
    expect(countTokens("hello world")).toBeGreaterThan(0);
  });

  it("longer text has more tokens", () => {
    const short = countTokens("hi");
    const long = countTokens("this is a much longer piece of text with many more tokens");
    expect(long).toBeGreaterThan(short);
  });

  it("counts literal special-token text without throwing", () => {
    expect(() => countTokens("before <|endoftext|> after")).not.toThrow();
    expect(countTokens("before <|endoftext|> after")).toBeGreaterThan(0);
  });
});

describe("serializeMessage", () => {
  it("serializes user message with string content", () => {
    resetMessageCounter();
    const msg = userMsg("hello there");
    const result = serializeMessage(msg);
    expect(result).toContain("role=user");
    expect(result).toContain("hello there");
    expect(result).toContain("timestamp=");
  });

  it("serializes user message with array content (text only)", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
      timestamp: 1_700_000_000_000,
    } as unknown as Message;
    const result = serializeMessage(msg);
    expect(result).toContain("role=user");
    expect(result).toContain("first");
    expect(result).toContain("second");
  });

  it("serializes assistant message with text + thinking + toolCall", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me think" },
        { type: "thinking", thinking: "internal reasoning" },
        { type: "toolCall", id: "tc-1", name: "read", input: '{"path":"/tmp/x"}' },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
    } as unknown as Message;
    const result = serializeMessage(msg);
    expect(result).toContain("role=assistant");
    expect(result).toContain("model=claude-test");
    expect(result).toContain("part:text Let me think");
    expect(result).toContain("part:thinking internal reasoning");
    expect(result).toContain("part:toolCall name=read");
    expect(result).toContain('{"path":"/tmp/x"}');
  });

  it("serializes toolResult message", () => {
    resetMessageCounter();
    const msg = toolResultMsg("read", "file contents here");
    const result = serializeMessage(msg);
    expect(result).toContain("role=toolResult");
    expect(result).toContain("tool=read");
    expect(result).toContain("file contents here");
  });

  it("falls back for unknown role", () => {
    const msg = { role: "unknown-role", timestamp: 1_700_000_000_000 } as unknown as Message;
    const result = serializeMessage(msg);
    expect(result).toContain("role=unknown-role");
  });
});

describe("countMessageTokens", () => {
  it("returns 0 for empty array", () => {
    expect(countMessageTokens([])).toBe(0);
  });

  it("sums tokens across messages", () => {
    resetMessageCounter();
    const msgs = [userMsg("first"), assistantMsg("second"), userMsg("third")];
    const total = countMessageTokens(msgs);
    const individual =
      countTokens(serializeMessage(msgs[0]!)) +
      countTokens(serializeMessage(msgs[1]!)) +
      countTokens(serializeMessage(msgs[2]!));
    expect(total).toBe(individual);
  });

  it("conversation(10) produces deterministic token count", () => {
    resetMessageCounter();
    const conv = conversation(10, { baseTs: 1_700_000_000_000, contentSize: 50 });
    const count1 = countMessageTokens(conv);
    resetMessageCounter();
    const conv2 = conversation(10, { baseTs: 1_700_000_000_000, contentSize: 50 });
    const count2 = countMessageTokens(conv2);
    expect(count1).toBe(count2);
    expect(count1).toBeGreaterThan(0);
  });
});

describe("message window helpers", () => {
  it("summarizes message and tool-result weight separately", () => {
    resetMessageCounter();
    const msgs = [
      userMsg("question"),
      toolResultMsg("read", "x".repeat(200)),
      assistantMsg("answer"),
      toolResultMsg("bash", "y".repeat(100)),
    ];

    const stats = summarizeMessageWindow(msgs);

    expect(stats.messageCount).toBe(4);
    expect(stats.toolResultCount).toBe(2);
    expect(stats.toolResultTokens).toBeGreaterThan(0);
    expect(stats.messageTokens).toBeGreaterThan(stats.toolResultTokens);
  });

  it("selects bounded chunks while keeping the first message when it alone exceeds the token limit", () => {
    resetMessageCounter();
    const msgs = [toolResultMsg("read", "x".repeat(6000)), toolResultMsg("read", "y".repeat(100))];

    const chunk = selectMessageChunk(msgs, { maxMessages: 1, maxTokens: 10 });

    expect(chunk).toHaveLength(1);
    expect(serializeMessage(chunk[0]!)).toContain("role=toolResult");
  });
});
