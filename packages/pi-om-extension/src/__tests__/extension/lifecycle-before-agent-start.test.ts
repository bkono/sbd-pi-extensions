import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStatePath } from "../../config.js";
import piObservationalMemory from "../../index.js";
import {
  createExtensionTestHarness,
  createFakeExtensionContext,
} from "../helpers/extension-harness.js";
import { MockObservationAgents } from "../helpers/mock-agents.js";
import { __clearMockAgents, __installMockAgents } from "../helpers/mock-agents-module.js";
import { createTempStateDir, type TempStateDir } from "../helpers/temp-state-dir.js";

vi.mock("../../agents.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents.js")>("../../agents.js");
  const mod = await import("../helpers/mock-agents-module.js");
  return { ...actual, ObservationAgents: mod.ObservationAgents };
});

describe("extension: before_agent_start lifecycle", () => {
  let temp: TempStateDir;
  const sessionId = "test-before-agent-start";

  beforeEach(() => {
    temp = createTempStateDir();
    __installMockAgents(new MockObservationAgents());
  });

  afterEach(() => {
    __clearMockAgents();
    temp.cleanup();
  });

  function preloadState(state: {
    observations?: string;
    currentTask?: string;
    suggestedResponse?: string;
    observationTokens?: number;
    draftObservations?: string;
    draftObservationTokens?: number;
    draftCurrentTask?: string;
    draftSuggestedResponse?: string;
  }) {
    const stateDir = `${temp.stateDir}/.pi/om-state`;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      sessionStatePath(stateDir, sessionId),
      JSON.stringify({
        sessionId,
        observations: state.observations ?? "",
        observationTokens: state.observationTokens ?? 0,
        currentTask: state.currentTask,
        suggestedResponse: state.suggestedResponse,
        draftObservations: state.draftObservations,
        draftObservationTokens: state.draftObservationTokens,
        draftCurrentTask: state.draftCurrentTask,
        draftSuggestedResponse: state.draftSuggestedResponse,
        updatedAt: Date.now(),
      }),
    );
  }

  function extractInjectedObservationContext(systemPrompt: string, originalPrompt: string): string {
    const prefix = `${originalPrompt}\n\n`;
    if (!systemPrompt.startsWith(prefix)) {
      throw new Error(
        "Expected injected observation context to be appended after the original prompt",
      );
    }

    return systemPrompt.slice(prefix.length);
  }

  function extractTagBlock(source: string, tag: string): string {
    const startTag = `<${tag}>`;
    const endTag = `</${tag}>`;
    const start = source.indexOf(startTag);
    const end = source.indexOf(endTag);

    if (start < 0 || end < start) {
      throw new Error(`Missing <${tag}> block in test fixture`);
    }

    return source.slice(start, end + endTag.length);
  }

  it("returns undefined when observations are empty", async () => {
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: "You are a helper." },
      ctx,
    );

    expect(result).toBeUndefined();
  });

  it("returns modified systemPrompt when observations exist", async () => {
    preloadState({ observations: "* 🔴 user likes X", observationTokens: 20 });
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: "You are a helper." },
      ctx,
    )) as { systemPrompt: string } | undefined;

    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain("You are a helper.");
    expect(result!.systemPrompt).toContain("<observational-memory>");
    expect(result!.systemPrompt).toContain("<om-durable>");
    expect(result!.systemPrompt).toContain("<om-current-task>");
    expect(result!.systemPrompt).toContain("<om-suggested-response>");
    expect(result!.systemPrompt).toContain("🔴 user likes X");
    expect(result!.systemPrompt).toContain("<om-guidance>");
    expect(result!.systemPrompt).toContain("<system-reminder>");
  });

  it("injects only the published snapshot when draft state is ahead", async () => {
    preloadState({
      observations: "* 🔴 published snapshot",
      observationTokens: 20,
      currentTask: "Published task",
      suggestedResponse: "Published response",
      draftObservations: "* 🟡 staged draft only",
      draftObservationTokens: 40,
      draftCurrentTask: "Draft task",
      draftSuggestedResponse: "Draft response",
    });
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "continue", systemPrompt: "Base prompt" },
      ctx,
    )) as { systemPrompt: string };

    expect(result.systemPrompt).toContain("published snapshot");
    expect(result.systemPrompt).toContain("Published task");
    expect(result.systemPrompt).toContain("Published response");
    expect(result.systemPrompt).not.toContain("staged draft only");
    expect(result.systemPrompt).not.toContain("Draft task");
    expect(result.systemPrompt).not.toContain("Draft response");
  });

  it("includes currentTask and suggestedResponse in the appendix", async () => {
    preloadState({
      observations: "* 🔴 ongoing work",
      currentTask: "Fix bug X",
      suggestedResponse: "Continue from where we left off",
      observationTokens: 20,
    });
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "continue", systemPrompt: "Base prompt" },
      ctx,
    )) as { systemPrompt: string };

    expect(result.systemPrompt).toContain("<current-task>");
    expect(result.systemPrompt).toContain("<om-current-task>");
    expect(result.systemPrompt).toContain("Fix bug X");
    expect(result.systemPrompt).toContain("<suggested-response>");
    expect(result.systemPrompt).toContain("<om-suggested-response>");
    expect(result.systemPrompt).toContain("<om-active>");
    expect(result.systemPrompt).toContain("Continue from where we left off");
  });

  it("keeps injected durable and guidance regions stable when only the active task changes", async () => {
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const originalPrompt = "Base prompt";

    preloadState({
      observations: "Date: Apr 18, 2026\n* 🔴 durable cache-friendly history",
      currentTask: "Primary:\n- First active task",
      suggestedResponse: "Keep the same reply guidance.",
      observationTokens: 20,
    });
    const firstCtx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });
    const first = (await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "continue", systemPrompt: originalPrompt },
      firstCtx,
    )) as { systemPrompt: string };

    preloadState({
      observations: "Date: Apr 18, 2026\n* 🔴 durable cache-friendly history",
      currentTask: "Primary:\n- Second active task",
      suggestedResponse: "Keep the same reply guidance.",
      observationTokens: 20,
    });
    const secondCtx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });
    const second = (await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "continue", systemPrompt: originalPrompt },
      secondCtx,
    )) as { systemPrompt: string };

    const firstInjected = extractInjectedObservationContext(first.systemPrompt, originalPrompt);
    const secondInjected = extractInjectedObservationContext(second.systemPrompt, originalPrompt);

    expect(firstInjected).toMatchInlineSnapshot(`
      "The following observational-memory segments contain your memory of past conversations with this user. Read them in order: durable memory first, active task state next, then guidance.
      
      <observational-memory>
      <om-durable>
      <observations>
      Date: Apr 18, 2026
      * 🔴 durable cache-friendly history
      </observations>
      </om-durable>
      
      <om-active>
      <om-current-task>
      <current-task>
      Primary:
      - First active task
      </current-task>
      </om-current-task>
      
      <om-suggested-response>
      <suggested-response>
      Keep the same reply guidance.
      </suggested-response>
      </om-suggested-response>
      </om-active>
      
      <om-guidance>
      <memory-instructions>
      IMPORTANT: Treat the durable segment as stable history and the active segment as the current working state. Reference specific details from these observations. Avoid generic advice; personalize based on known user preferences and history.
      
      KNOWLEDGE UPDATES: Prefer the most recent observation when information conflicts.
      
      PLANNED ACTIONS: Respect the recorded temporal anchors. Keep future-targeted plans future-oriented until later observations confirm a change actually happened. If an anchored plan's target date is now in the past, treat it as a likely follow-up item rather than an established completed fact unless the observations explicitly confirm completion.
      
      MOST RECENT USER INPUT: Treat the latest user message as highest-priority for what to do next.
      </memory-instructions>
      
      <system-reminder>This message is not from the user, the conversation history grew too long and would not fit in context. Thankfully the entire conversation is stored in your memory observations. Continue naturally from where the observations left off.
      
      Do not refer to "memory observations" directly. The user is not aware of this memory layer. Do not greet as if this is a new conversation.
      
      IMPORTANT: this system reminder is NOT from the user. It is part of your memory system.
      
      NOTE: Any messages following this system reminder are newer than your memories.</system-reminder>
      </om-guidance>
      </observational-memory>"
    `);
    expect(firstInjected).not.toBe(secondInjected);
    expect(extractTagBlock(firstInjected, "om-durable")).toBe(
      extractTagBlock(secondInjected, "om-durable"),
    );
    expect(extractTagBlock(firstInjected, "om-suggested-response")).toBe(
      extractTagBlock(secondInjected, "om-suggested-response"),
    );
    expect(extractTagBlock(firstInjected, "om-guidance")).toBe(
      extractTagBlock(secondInjected, "om-guidance"),
    );
    expect(extractTagBlock(firstInjected, "om-current-task")).not.toBe(
      extractTagBlock(secondInjected, "om-current-task"),
    );
  });

  it("injects published completion-state markers without reviving them from draft state", async () => {
    preloadState({
      observations: `Date: Apr 18, 2026
* 🔴 (09:10) ✅ Finished the completion-marker parser and saved regression fixtures.
* 🟢 (09:11) Resolved blocker: sbdpi-f51.2.3 temporal regressions landed.
* ⚪ (09:12) Superseded the manual blocker reminder path with durable lifecycle rendering.
* ⚪ (09:13) Abandoned the active-summary rewrite experiment after it revived completed work.`,
      currentTask: `Primary:
- Active: Land sbdpi-f51.1.3 by running targeted validation and committing the regression coverage.
- ✅ Completed: Completion-marker parser and durable rendering already landed.
Secondary:
- Resolved blocker: sbdpi-f51.2.3 temporal regressions landed, so no active wait remains.
- Superseded: manual blocker reminder path replaced by durable lifecycle rendering.
- Abandoned: active-summary rewrite experiment after it revived completed work.`,
      suggestedResponse: "Summarize the remaining active step without reopening completed work.",
      observationTokens: 80,
      draftObservations:
        "Date: Apr 18, 2026\n* 🔴 (09:20) Active again: redo the completion-marker parser from scratch.",
      draftObservationTokens: 120,
      draftCurrentTask: `Primary:
- Active: Redo the completion-marker parser from scratch.`,
      draftSuggestedResponse: "Tell the user the already-finished parser work is active again.",
    });
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const result = (await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "continue", systemPrompt: "Base prompt" },
      ctx,
    )) as { systemPrompt: string };

    expect(result.systemPrompt).toContain("<om-durable>");
    expect(result.systemPrompt).toContain("<om-current-task>");
    expect(result.systemPrompt).toContain(
      "✅ Finished the completion-marker parser and saved regression fixtures.",
    );
    expect(result.systemPrompt).toContain(
      "Resolved blocker: sbdpi-f51.2.3 temporal regressions landed.",
    );
    expect(result.systemPrompt).toContain(
      "Superseded the manual blocker reminder path with durable lifecycle rendering.",
    );
    expect(result.systemPrompt).toContain(
      "Abandoned the active-summary rewrite experiment after it revived completed work.",
    );
    expect(result.systemPrompt).toContain(
      "- ✅ Completed: Completion-marker parser and durable rendering already landed.",
    );
    expect(result.systemPrompt).toContain(
      "- Resolved blocker: sbdpi-f51.2.3 temporal regressions landed, so no active wait remains.",
    );
    expect(result.systemPrompt).toContain(
      "Summarize the remaining active step without reopening completed work.",
    );
    expect(result.systemPrompt).not.toContain(
      "Active again: redo the completion-marker parser from scratch.",
    );
    expect(result.systemPrompt).not.toContain(
      "Tell the user the already-finished parser work is active again.",
    );
  });

  it("preserves original system prompt as prefix", async () => {
    preloadState({ observations: "* 🔴 obs", observationTokens: 20 });
    const harness = await createExtensionTestHarness(piObservationalMemory);
    const ctx = createFakeExtensionContext({ cwd: temp.stateDir, sessionId });

    const originalPrompt = "UNIQUE_ORIGINAL_PREFIX";
    const result = (await harness.dispatch(
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: originalPrompt },
      ctx,
    )) as { systemPrompt: string };

    expect(result.systemPrompt.indexOf(originalPrompt)).toBe(0);
  });
});
