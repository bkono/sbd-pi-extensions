import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { completeWithFailover } from "../models.js";
import { observe, PI_OBSERVER_INSTRUCTION } from "../observer.js";
import { SessionOM } from "../runtime.js";
import { replayState } from "../state.js";
import { formatTranscript } from "../transcript.js";
import { buildObserverSystemPrompt, buildReflectorSystemPrompt } from "../upstream/prompts";
import {
  append,
  assistantText,
  config,
  contextMessages,
  fakeModel,
  fakeRegistry,
  makeHost,
  newSession,
  OBSERVATION_RESPONSE,
  systemMessages,
  toolStep,
  user,
  words,
} from "./helpers.js";

/** Parity with Mastra Code's OM configuration (@mastra/code-sdk 1.18.0, memory.ts). */
describe("Mastra Code parity", () => {
  it("observer prompt carries the extractor sections Mastra Code composes", () => {
    const observer = buildObserverSystemPrompt(PI_OBSERVER_INSTRUCTION);
    expect(observer).toContain("Additional optional XML sections:");
    expect(observer).toContain("<current-task>");
    expect(observer).toContain(
      "If the agent started doing something without user approval, note that it's off-task.",
    );
    expect(observer).toContain("<suggested-response>");
    expect(observer).toContain("<thread-title>");
    const reflector = buildReflectorSystemPrompt();
    expect(reflector).toContain("<current-task>");
    expect(reflector).not.toContain("<thread-title>");
  });

  it("temporalMarkers: a user message after a 10+ minute gap gets a stable system-reminder", () => {
    const session = newSession();
    const registry = fakeRegistry();
    const host = makeHost(session, registry);
    const om = new SessionOM(session.getSessionId(), config());
    const start = Date.now() - 3 * 3_600_000;
    append(session, user("first", start));
    append(session, assistantText("reply", { timestamp: start + 1_000 }));
    append(session, user("quick follow-up", start + 60_000));
    append(session, assistantText("ok", { timestamp: start + 61_000 }));
    append(session, user("back after lunch", start + 2 * 3_600_000));
    const full = [...systemMessages(), ...contextMessages(session)];
    const once = om.onSystem(full, host)!;
    const twice = om.onSystem(full, host)!;
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    const reminders = once.filter((m) => JSON.stringify(m).includes("later —"));
    expect(reminders).toHaveLength(1);
    expect(JSON.stringify(reminders[0])).toContain("1 hour 58 minutes later");
    const index = once.indexOf(reminders[0]!);
    expect(JSON.stringify(once[index + 1])).toContain("back after lunch");
  });

  it("temporalMarkers: the observer transcript shows the gap too", () => {
    const start = Date.now() - 3 * 3_600_000;
    const text = formatTranscript(
      [assistantText("reply", { timestamp: start }), user("back", start + 45 * 60_000)],
      { toolResultMaxTokens: 5_000 },
    );
    expect(text).toMatch(/45 minutes later — /);
  });

  it("threadTitle: the observer's title names the session unless the user named it", async () => {
    const titled = `${OBSERVATION_RESPONSE}\n\n<thread-title>Auth bug fix</thread-title>`;
    for (const preset of [undefined, "My own name"]) {
      const session = newSession();
      const registry = fakeRegistry();
      registry.respond = () => titled;
      let name = preset;
      const host = {
        ...makeHost(session, registry),
        getSessionName: () => name,
        setSessionName: (value: string) => {
          name = value;
        },
      };
      const om = new SessionOM(session.getSessionId(), config());
      append(session, user("fix auth"));
      om.startRun(host);
      await toolStep(om, session, host, 7_000);
      await om.settled();
      expect(name).toBe(preset ?? "Auth bug fix");
    }
  });

  it("reflection keeps observation-group provenance for recall", async () => {
    const session = newSession();
    const registry = fakeRegistry();
    const big = `<observations>\nDate: Nov 11, 2026\n${Array.from({ length: 600 }, (_, i) => `* 🟡 (10:${String(i % 60).padStart(2, "0")}) Agent learned fact ${i}: ${words(8)}`).join("\n")}\n</observations>`;
    registry.respond = (context) =>
      String(context.systemPrompt).includes("observation reflector")
        ? "<observations>\nDate: Nov 11, 2026\n* 🔴 (10:00) Consolidated memory\n</observations>"
        : big;
    const host = makeHost(session, registry);
    const om = new SessionOM(session.getSessionId(), config());
    append(session, user("go"));
    om.startRun(host);
    for (let step = 0; step < 14; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    const reflection = replayState(session.getBranch()).reflection;
    expect(reflection?.observations).toContain("Consolidated memory");
    expect(reflection?.observations).toMatch(/<observation-group id="[^"]+" range="[^":]+:[^"]+"/);
  });

  it("retries a transient failure on the same model before failing over", async () => {
    const registry = fakeRegistry(["openai-codex/gpt-6-luna", "anthropic/claude-haiku-5-5"]);
    let codexCalls = 0;
    registry.respond = (_context, model) => {
      if (model.provider === "openai-codex" && codexCalls++ === 0)
        throw new Error("429 rate limited");
      return "ok";
    };
    const result = await completeWithFailover(
      registry,
      [fakeModel("openai-codex", "gpt-6-luna"), fakeModel("anthropic", "claude-haiku-5-5")],
      { messages: [{ role: "user", content: "x", timestamp: 0 }] },
      { timeoutMs: 1_000, retryDelaysMs: [1] },
    );
    expect(result.model.provider).toBe("openai-codex");
    expect(codexCalls).toBe(2);
  });

  it("forwards images to observers that accept them and drops them otherwise", async () => {
    const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "look" }, image],
        timestamp: Date.now(),
      } as AgentMessage,
    ];
    for (const accepts of [true, false]) {
      const registry = fakeRegistry();
      let sent: unknown;
      registry.streamSimple = (_model, context) => ({
        result: async () => {
          sent = context.messages[0]?.content;
          return {
            role: "assistant",
            content: [{ type: "text", text: OBSERVATION_RESPONSE }],
            stopReason: "stop",
            timestamp: 0,
          } as never;
        },
      });
      const model = {
        ...fakeModel("openai-codex", "gpt-6-luna"),
        input: accepts ? ["text", "image"] : ["text"],
      } as Model<Api>;
      await observe(
        registry,
        [model],
        {
          messages,
          activeObservations: "",
          previousObserverTokens: 1_000,
          toolResultMaxTokens: 5_000,
        },
        { timeoutMs: 1_000 },
      );
      expect(JSON.stringify(sent).includes("aGVsbG8=")).toBe(accepts);
    }
  });

  it("PI_OM_MODEL goes first, and a fallback away from it is visible", async () => {
    const session = newSession();
    const registry = fakeRegistry([
      "huggingface/deepseek-ai/DeepSeek-V4-Flash",
      "openai-codex/gpt-6-luna",
    ]);
    registry.respond = (_context, model) => {
      if (model.provider === "huggingface") throw new Error("402 Purchase pre-paid credits");
      return OBSERVATION_RESPONSE;
    };
    const host = makeHost(session, registry);
    const om = new SessionOM(
      session.getSessionId(),
      config({ modelOverride: "huggingface/deepseek-ai/DeepSeek-V4-Flash" }),
    );
    append(session, user("go"));
    om.startRun(host);
    await toolStep(om, session, host, 7_000);
    await om.settled();
    expect(registry.calls[0]?.model).toBe("huggingface/deepseek-ai/DeepSeek-V4-Flash");
    const failover = om.events.find((e) => e.kind === "failover");
    expect(failover?.detail).toMatch(/huggingface.*402.*→ openai-codex\/gpt-6-luna/);
    expect(om.snapshot(host).lastFailover).toBeDefined();
  });

  it("reflector user message carries prior values and output sections (sync) or neither (buffered)", async () => {
    const { buildReflectorUserMessage } = await import("../reflector.js");
    const sync = buildReflectorUserMessage("* 🔴 (10:00) x", 1, { priorCurrentTask: "Primary: y" });
    expect(sync).toContain(
      "## Prior Extracted Values\n\n<current-task>\nPrimary: y\n</current-task>",
    );
    expect(sync).toContain("## Additional Output Sections");
    const buffered = buildReflectorUserMessage("* 🔴 (10:00) x", 1, {
      buffered: true,
      priorCurrentTask: "Primary: y",
    });
    expect(buffered).not.toContain("Prior Extracted Values");
    expect(buffered).not.toContain("Additional Output Sections");
    expect(buffered).toMatch(/Output <observations> every time\.$/);
  });

  it("the observer sees the gap at the start of a batch", () => {
    const start = Date.now() - 3 * 3_600_000;
    const text = formatTranscript([user("back", start + 45 * 60_000)], {
      toolResultMaxTokens: 5_000,
      previousMessage: assistantText("reply", { timestamp: start }),
    });
    expect(text).toMatch(/^45 minutes later — /);
  });

  it("transient classification is anchored", async () => {
    const { isTransientFailure } = await import("../models.js");
    for (const t of [
      "429 Too Many Requests",
      "HTTP 503 Service Unavailable",
      "status code 502",
      "rate limit exceeded",
      "socket hang up",
    ])
      expect(isTransientFailure(t)).toBe(true);
    for (const f of [
      "402 Payment Required: balance 500 credits",
      "400 max_tokens must be <= 512",
      "403 Forbidden: network policy",
      "400 Unsupported parameter: 'timeout'",
      "401 Unauthorized",
    ])
      expect(isTransientFailure(f)).toBe(false);
  });

  it("observer reasoning matches Mastra Code: medium on Codex, none on Anthropic", async () => {
    const { observerReasoning } = await import("../models.js");
    expect(
      observerReasoning({
        ...fakeModel("openai-codex", "gpt-6-luna"),
        reasoning: true,
      } as Model<Api>),
    ).toBe("medium");
    expect(
      observerReasoning({
        ...fakeModel("anthropic", "claude-haiku-5-5"),
        reasoning: true,
      } as Model<Api>),
    ).toBeUndefined();
  });
});
