import { describe, expect, it } from "vitest";

import {
  type ContextUnit,
  computeStatus,
  decideReflection,
  describeUnit,
  selectActivationCount,
  selectSafePrefix,
  shouldBuffer,
} from "../engine.js";
import { completeWithFailover, resolveModelCandidates } from "../models.js";
import {
  buildObserverUserMessage,
  PI_OBSERVER_INSTRUCTION,
  parseObserverResponse,
} from "../observer.js";
import { buildObserverSystemPrompt } from "../upstream/prompts";

function registryPromptForTest(): string {
  return buildObserverSystemPrompt(PI_OBSERVER_INSTRUCTION);
}

import { type ChunkData, replayState } from "../state.js";
import { formatTranscript } from "../transcript.js";
import {
  assistantText,
  assistantToolCall,
  config,
  fakeRegistry,
  OBSERVATION_RESPONSE,
  toolResult,
  user,
  words,
} from "./helpers.js";

function unit(id: string, tokens: number, extra: Partial<ContextUnit> = {}): ContextUnit {
  return {
    entryId: id,
    messages: [user(id)],
    tokens,
    observable: true,
    read: true,
    role: "user",
    toolCallIds: [],
    toolResultIds: [],
    ...extra,
  };
}

function chunk(id: string, entryIds: string[], messageTokens: number): ChunkData {
  return {
    v: 1,
    id,
    observations: `* 🔴 (10:00) ${id}`,
    observationTokens: 10,
    messageTokens,
    entryIds,
    range: `${entryIds[0]}:${entryIds.at(-1)}`,
    createdAt: 0,
    model: "m",
  };
}

describe("pi version gate", () => {
  it("requires Pi 0.87+, where context_with_system and context edits exist", async () => {
    const { isSupportedPiVersion } = await import("../index.js");
    expect(isSupportedPiVersion("0.80.2")).toBe(false);
    expect(isSupportedPiVersion("0.87.0")).toBe(true);
    expect(isSupportedPiVersion("1.3.0")).toBe(true);
    expect(isSupportedPiVersion(undefined)).toBe(false);
  });
});

describe("config", () => {
  it("resolves Mastra Code's numbers to absolute tokens", () => {
    const c = config();
    expect(c.messageTokens).toBe(30_000);
    expect(c.bufferTokens).toBe(6_000);
    expect(c.retentionFloor).toBe(2_000);
    expect(c.observationBlockAfter).toBe(60_000);
    expect(c.previousObserverTokens).toBe(1_000);
    expect(c.reflectionTokens).toBe(40_000);
    expect(c.reflectionBufferAt).toBe(20_000);
    expect(c.reflectionBlockAfter).toBe(44_000);
  });
});

describe("transcript", () => {
  it("includes tool arguments, the field the 0.3 serializer dropped", () => {
    const text = formatTranscript(
      [
        assistantToolCall("c1", "read", { path: "src/auth.ts", offset: 1, limit: 200 }),
        toolResult("c1", "read", "export function auth() {}"),
      ],
      { toolResultMaxTokens: 5_000 },
    );
    expect(text).toContain("Tool Call read");
    expect(text).toContain('"path":"src/auth.ts"');
    expect(text).toContain("Tool Result read");
    expect(text).not.toContain("input={}");
  });

  it("caps tool results at the token budget", () => {
    const text = formatTranscript([toolResult("c1", "read", words(20_000))], {
      toolResultMaxTokens: 5_000,
    });
    expect(text).toMatch(/\[truncated ~\d+ tokens\]/);
    expect(text.length).toBeLessThan(40_000);
  });

  it("previews long string arguments instead of inlining them", () => {
    const text = formatTranscript(
      [assistantToolCall("c1", "edit", { path: "a.ts", newText: "x".repeat(5_000) })],
      { toolResultMaxTokens: 5_000 },
    );
    expect(text).toContain("[5000 chars]");
  });
});

describe("observer prompt", () => {
  it("sends at most ~1k tokens of prior observations and says when it truncated", () => {
    const prior = Array.from(
      { length: 400 },
      (_, i) => `* 🟡 (10:00) observation number ${i} ${words(10)}`,
    ).join("\n");
    const message = buildObserverUserMessage({
      messages: [user("hi")],
      activeObservations: prior,
      previousObserverTokens: 1_000,
      toolResultMaxTokens: 5_000,
    });
    const previous = message.split("## New Message History to Observe")[0]!;
    expect(previous.length / 4).toBeLessThan(1_400);
    expect(message).toContain("Previous observations were truncated");
  });

  it("guards current-task against describing the observer's own job (0.3 lesson)", () => {
    const system = registryPromptForTest();
    expect(system).toContain("Never describe your own observation or extraction work there.");
  });

  it("parses observations, current task and suggested response", () => {
    const parsed = parseObserverResponse(OBSERVATION_RESPONSE);
    expect(parsed?.observations).toContain("User asked to fix auth bug");
    expect(parsed?.currentTask).toBe("Primary: fix auth bug");
    expect(parsed?.suggestedResponse).toBe("Continue fixing the auth bug.");
  });

  it("rejects degenerate repetition", () => {
    // A single run of identical lines is a faithful summary upstream; a loop alternates.
    const loop = `<observations>\n${Array.from({ length: 80 }, (_, i) => (i % 2 ? "* 🟡 (10:00) Agent ran the same build command again and again" : "* 🟡 (10:01) Agent read the same build log output once more")).join("\n")}\n</observations>`;
    expect(parseObserverResponse(loop)).toBeUndefined();
  });
});

describe("models", () => {
  it("prefers Codex, then Anthropic, filtered by configured auth", () => {
    const both = fakeRegistry(["openai-codex/gpt-6-luna", "anthropic/claude-haiku-5-5"]);
    expect(resolveModelCandidates(both).map((m) => `${m.provider}/${m.id}`)).toEqual([
      "openai-codex/gpt-6-luna",
      "anthropic/claude-haiku-5-5",
    ]);
    const anthropicOnly = fakeRegistry(["anthropic/claude-haiku-4-5"]);
    expect(resolveModelCandidates(anthropicOnly).map((m) => m.id)).toEqual(["claude-haiku-4-5"]);
    expect(resolveModelCandidates(fakeRegistry([]))).toEqual([]);
  });

  it("puts PI_OM_MODEL first when it has auth", () => {
    const registry = fakeRegistry(["google/gemini-3.5-flash", "openai-codex/gpt-6-luna"]);
    expect(resolveModelCandidates(registry, "google/gemini-3.5-flash").map((m) => m.id)).toEqual([
      "gemini-3.5-flash",
      "gpt-6-luna",
    ]);
  });

  it("fails over to the next model on an error", async () => {
    const registry = fakeRegistry(["openai-codex/gpt-6-luna", "anthropic/claude-haiku-5-5"]);
    registry.respond = (_context, model) => {
      if (model.provider === "openai-codex") throw new Error("rate limited");
      return "ok";
    };
    const result = await completeWithFailover(
      registry,
      resolveModelCandidates(registry),
      { messages: [{ role: "user", content: "x", timestamp: 0 }] },
      { timeoutMs: 1_000 },
    );
    expect(result.model.provider).toBe("anthropic");
    expect(result.text).toBe("ok");
  });
});

describe("engine", () => {
  it("never splits a tool exchange", () => {
    const units = [
      unit("u1", 10),
      unit("a1", 10, { role: "assistant", toolCallIds: ["c1", "c2"] }),
      unit("r1", 10, { role: "toolResult", toolResultIds: ["c1"] }),
      unit("r2", 10, { role: "toolResult", toolResultIds: ["c2"] }),
      unit("a2", 10, { role: "assistant", toolCallIds: ["c3"] }),
    ];
    expect(selectSafePrefix(units).map((u) => u.entryId)).toEqual(["u1", "a1", "r1", "r2"]);
  });

  it("buffers every 6k unbuffered tokens, halving near the threshold", () => {
    const c = config();
    const state = replayState([]);
    const below = computeStatus([unit("a", 5_999)], state, c);
    expect(shouldBuffer(below, c)).toBe(false);
    const at = computeStatus([unit("a", 6_000)], state, c);
    expect(shouldBuffer(at, c)).toBe(true);
    // pending 24k is past the ramp point (30k - 6.6k), so 3k unbuffered is enough
    const buffered = { ...state, bufferedEntryIds: new Set(["a"]) };
    const nearThreshold = computeStatus([unit("a", 21_000), unit("b", 3_000)], buffered, c);
    expect(shouldBuffer(nearThreshold, c)).toBe(true);
  });

  it("never buffers at blockAfter, where the blocking path takes over", () => {
    const c = config();
    const status = computeStatus([unit("a", 60_000)], replayState([]), c);
    expect(status.mustBlock).toBe(true);
    expect(shouldBuffer(status, c)).toBe(false);
  });

  it("activates down to the retention floor at a chunk boundary (Mastra boundary math)", () => {
    const chunks = [
      chunk("c1", ["a"], 6_000),
      chunk("c2", ["b"], 6_000),
      chunk("c3", ["c"], 6_000),
    ];
    // 31k pending, keep ~2k: target 29k; all three chunks (18k) are under target.
    expect(selectActivationCount(chunks, 31_000, 2_000)).toBe(3);
    // 14k pending: target 12k, exactly two chunks.
    expect(selectActivationCount(chunks, 14_000, 2_000)).toBe(2);
    // Nothing to remove when already within the floor.
    expect(selectActivationCount(chunks, 1_500, 2_000)).toBe(0);
  });

  it("reflects in the background from 20k, swaps at 40k, blocks only at 44k", () => {
    const c = config();
    const d = (
      observationTokens: number,
      hasBufferedReflection = false,
      reflectionInFlight = false,
    ) =>
      decideReflection({ observationTokens, hasBufferedReflection, reflectionInFlight, config: c })
        .kind;
    expect(d(19_999)).toBe("none");
    expect(d(20_000)).toBe("start-buffer");
    expect(d(25_000, false, true)).toBe("none");
    expect(d(40_000, true)).toBe("activate-buffer");
    expect(d(41_000, false, true)).toBe("none");
    expect(d(44_000)).toBe("sync");
  });

  it("marks summaries as not observable", () => {
    const summary = describeUnit(
      "s",
      "compaction",
      [{ role: "compactionSummary", summary: "x", tokensBefore: 1, timestamp: 0 } as never],
      5,
      true,
    );
    expect(summary.observable).toBe(false);
    expect(describeUnit("a", "message", [assistantText("hi")], 1, true).observable).toBe(true);
  });
});
