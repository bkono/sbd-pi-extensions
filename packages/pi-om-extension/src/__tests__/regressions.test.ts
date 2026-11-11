import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";

import { OM_SECTION } from "../context.js";
import { protectedRequestId, SessionOM } from "../runtime.js";
import { OM_ACTIVATION, replayState } from "../state.js";
import {
  append,
  assistantText,
  assistantToolCall,
  commit,
  config,
  contextMessages,
  deferred,
  type FakeRegistry,
  fakeRegistry,
  makeHost,
  newSession,
  OBSERVATION_RESPONSE,
  request,
  systemMessages,
  toolResult,
  toolStep,
  user,
} from "./helpers.js";

async function request_(om: SessionOM): Promise<AgentMessage[]> {
  return request(om, sessionRef!, hostRef!);
}
let sessionRef: SessionManager | undefined;
let hostRef: ReturnType<typeof makeHost> | undefined;

/** Regressions from the fresh-eyes review of the v2 rewrite (findings 1-8). */
describe("review regressions", () => {
  let session: SessionManager;
  let registry: FakeRegistry;
  let host: ReturnType<typeof makeHost>;
  let om: SessionOM;

  beforeEach(() => {
    session = newSession();
    registry = fakeRegistry();
    host = makeHost(session, registry);
    om = new SessionOM(session.getSessionId(), config());
    sessionRef = session;
    hostRef = host;
    append(session, user("start"));
    om.startRun(host);
  });

  function activations(): number {
    return session
      .getBranch()
      .filter(
        (e) => e.type === "custom" && (e as { customType: string }).customType === OM_ACTIVATION,
      ).length;
  }

  it("1: a `!cmd` bash entry is never covered, so every boundary stays valid", async () => {
    append(session, {
      role: "bashExecution",
      command: "cat notes.txt",
      output: "x".repeat(4_000),
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage);
    // commit() goes through SessionManager.appendContextEdit, which throws on a
    // non-editable target exactly as Pi's boundary validation does.
    for (let step = 0; step < 7; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    expect(activations()).toBeGreaterThan(0);
  });

  it("2: an aborted tool call does not wedge buffering", async () => {
    append(session, {
      ...(assistantToolCall("dead", "read", { path: "x" }) as object),
      stopReason: "aborted",
    } as AgentMessage);
    append(session, user("try again"));
    for (let step = 0; step < 8; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    const snapshot = om.snapshot(host);
    expect(registry.calls.length).toBeGreaterThan(1);
    expect(snapshot.status.mustBlock).toBe(false);
    expect(activations()).toBeGreaterThan(0);
  });

  it("2b: an orphaned call is not live once the conversation moves on", async () => {
    append(session, assistantToolCall("orphan", "read", { path: "y" }));
    append(session, user("never mind"));
    for (let step = 0; step < 8; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    expect(activations()).toBeGreaterThan(0);
  });

  it("3: losing model auth keeps existing memory injected", async () => {
    for (let step = 0; step < 6; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    expect(activations()).toBeGreaterThan(0);
    registry.auth.clear();
    const full = [...systemMessages(), ...contextMessages(session)];
    const out = om.onSystem(full, host);
    const section = (out?.[0] as { sections?: Record<string, string> } | undefined)?.sections?.[
      OM_SECTION
    ];
    expect(section).toContain("<observations>");
    expect(host.statuses.at(-1)).toMatch(/paused · no observer model/);
  });

  it("4: a chunk that finishes after /tree is dropped", async () => {
    const held = deferred<string>();
    registry.respond = () => held.promise;
    await toolStep(om, session, host, 7_000);
    om.onTreeChange(host);
    held.resolve(OBSERVATION_RESPONSE);
    await om.settled();
    commit(
      session,
      om.onSettle({ contextEntries: session.buildSessionProjection().entries }, host),
    );
    expect(replayState(session.getBranch()).chunks.size).toBe(0);
    expect(om.events.some((e) => e.kind === "dropped")).toBe(true);
  });

  it("5: mid-transcript system messages stay in place", async () => {
    for (let step = 0; step < 6; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    const delta = { role: "system", content: "tool loadout changed", timestamp: 1 } as AgentMessage;
    const conversation = contextMessages(session);
    const full = [
      ...systemMessages(),
      ...conversation.slice(0, 1),
      delta,
      ...conversation.slice(1),
    ];
    const out = om.onSystem(full, host)!;
    expect(out.filter((m) => (m as { role?: string }).role === "system")).toHaveLength(2);
    expect(out).toContain(delta);
  });

  it("6: a cancelled compaction leaves no activation without its edits", async () => {
    for (let step = 0; step < 4; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    await request(om, session, host);
    const before = activations();
    const controller = new AbortController();
    const compaction = om.onCompact(host, controller.signal);
    controller.abort();
    expect(await compaction).toBeUndefined();
    expect(activations()).toBe(before);
    // the next boundary commits activation and edits together
    const drafts = await om.onTurnEnd(
      { contextEntries: session.buildSessionProjection().entries },
      host,
    );
    commit(session, drafts);
    const state = replayState(session.getBranch());
    const projected = new Set(
      session
        .buildSessionProjection()
        .entries.filter((e) => e.messages.length > 0)
        .map((e) => e.sourceEntry.id),
    );
    const keepRaw = protectedRequestId(session.buildSessionProjection().entries);
    for (const id of state.observedEntryIds)
      if (id !== keepRaw) expect(projected.has(id)).toBe(false);
  });

  it("7: tool results the model never saw are not activated at the next run start", async () => {
    for (let step = 0; step < 3; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    // a run that ends right after its tools ran: no assistant message follows the results
    append(
      session,
      assistantToolCall("last", "read", { path: "z" }, { timestamp: Date.now() - 2 * 3_600_000 }),
    );
    const unseen = append(session, toolResult("last", "read", "secret tail result"));
    commit(
      session,
      om.onSettle({ contextEntries: session.buildSessionProjection().entries }, host),
    );
    await om.settled();
    commit(
      session,
      om.onSettle({ contextEntries: session.buildSessionProjection().entries }, host),
    );
    append(session, user("continue"));
    om.startRun(host);
    const sent = await request(om, session, host);
    expect(sent.some((m) => JSON.stringify(m).includes("secret tail result"))).toBe(true);
    expect(replayState(session.getBranch(), []).observedEntryIds.has(unseen)).toBe(false);
  });

  it("8: a failing blocking observation backs off instead of retrying every turn", async () => {
    registry.respond = () => {
      throw new Error("provider down");
    };
    await request(om, session, host);
    append(session, assistantToolCall("big", "read", { path: "big" }));
    append(session, toolResult("big", "read", "lorem ".repeat(70_000)));
    append(session, assistantText("read it"));
    await om.onTurnEnd({ contextEntries: session.buildSessionProjection().entries }, host);
    const callsAfterFirst = registry.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await om.onTurnEnd({ contextEntries: session.buildSessionProjection().entries }, host);
    expect(registry.calls.length).toBe(callsAfterFirst);
    expect(om.snapshot(host).lastError).toMatch(/provider down/);
  });

  it("R1: Pi auto-retry omitting a buffered error response does not strand its chunk", async () => {
    await request(om, session, host);
    // Pi persists the failed attempt, OM buffers it at turn_end, then Pi's
    // _omitRecoveryAttempt edits it out of context before retrying.
    const failed = append(session, {
      ...(assistantText("partial") as object),
      stopReason: "error",
      errorMessage: "429",
    } as AgentMessage);
    for (let step = 0; step < 2; step += 1) {
      await toolStep(om, session, host, 4_000);
      await om.settled();
    }
    commit(
      session,
      om.onSettle({ contextEntries: session.buildSessionProjection().entries }, host),
    );
    await om.settled();
    commit(
      session,
      om.onSettle({ contextEntries: session.buildSessionProjection().entries }, host),
    );
    const before = replayState(session.getBranch());
    expect([...before.chunks.values()].some((chunk) => chunk.entryIds.includes(failed))).toBe(true);
    session.appendContextEdit(failed, null);

    for (let step = 0; step < 10; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    // every in-context entry the stale chunk covered was re-observed and activated
    const state = replayState(session.getBranch());
    const stale = [...before.chunks.values()].find((chunk) => chunk.entryIds.includes(failed))!;
    const projected = new Set(
      session
        .buildSessionProjection()
        .entries.filter((e) => e.messages.length > 0)
        .map((e) => e.sourceEntry.id),
    );
    for (const id of stale.entryIds) {
      if (id === failed) continue;
      expect(projected.has(id) && !state.observedEntryIds.has(id)).toBe(false);
    }
    expect(om.snapshot(host).status.pendingTokens).toBeLessThan(30_000);
  });

  it("R2: each OM compaction summary is unique", async () => {
    const summaries: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      for (let step = 0; step < 4; step += 1) {
        await toolStep(om, session, host, 6_000);
        await om.settled();
      }
      await request(om, session, host);
      const result = await om.onCompact(host);
      expect(result).toBeDefined();
      summaries.push(result!.summary);
      session.appendCompaction(result!.summary, result!.firstKeptEntryId, 0);
      om.onCompacted(host);
    }
    expect(new Set(summaries).size).toBe(2);
  });

  it("buffered observer calls skip continuation hints, like Mastra's async buffer", async () => {
    await toolStep(om, session, host, 7_000);
    await om.settled();
    const call = registry.calls[0]!;
    expect(call.system).toContain("<thread-title>");
    expect(call.system).not.toContain("<current-task>");
    expect(call.system).not.toContain("<suggested-response>");
    expect(call.user).toMatch(/Output <observations> every time\.$/);
  });

  it("sync observation gets the full extractor set and prior blocks", async () => {
    const { buildObserverUserMessage } = await import("../observer.js");
    const user = buildObserverUserMessage({
      messages: [],
      activeObservations: "",
      priorCurrentTask: "Primary: read all files",
      priorThreadTitle: "File reads",
      previousObserverTokens: 1_000,
      toolResultMaxTokens: 5_000,
    });
    expect(user).toContain("- prior current-task: Primary: read all files");
    expect(user).toContain("<current-task>\nPrimary: read all files\n</current-task>");
    expect(user).toContain("<thread-title>\nFile reads\n</thread-title>");
    expect(user).not.toContain("Output <observations> every time.");
  });

  it("the run's request stays raw through activation, and is edited once a newer request exists", async () => {
    const request = session.getBranch().find((e) => e.type === "message")!.id;
    for (let step = 0; step < 7; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    const state = replayState(session.getBranch());
    expect(state.observedEntryIds.has(request)).toBe(true);
    const projectedIds = () =>
      new Set(
        session
          .buildSessionProjection()
          .entries.filter((e) => e.messages.length > 0)
          .map((e) => e.sourceEntry.id),
      );
    expect(projectedIds().has(request)).toBe(true);
    const sent = await request_(om);
    expect(sent.some((m) => JSON.stringify(m).includes("start"))).toBe(true);
    // A new run: the old request is no longer protected, but its edit is deferred to the
    // next activation, so the new run's first request extends the last one (cache-stable).
    const lastOfRun1 = await request_(om);
    append(session, user("next task"));
    om.startRun(host);
    const firstOfRun2 = await request_(om);
    expect(JSON.stringify(firstOfRun2.slice(0, lastOfRun1.length))).toBe(
      JSON.stringify(lastOfRun1),
    );
    expect(projectedIds().has(request)).toBe(true);
    // the next activation commits the deferred edit
    for (let step = 0; step < 6; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    expect(projectedIds().has(request)).toBe(false);
  });

  it("observer context excludes stale buffered chunks", async () => {
    const { renderObserverContext } = await import("../state.js");
    const { liveBufferedChunks, describeUnit } = await import("../engine.js");
    const chunk = (id: string, entryIds: string[]) => ({
      v: 1 as const,
      id,
      observations: `* 🔴 (10:00) ${id} fact`,
      observationTokens: 5,
      messageTokens: 10,
      entryIds,
      range: `${entryIds[0]}:${entryIds.at(-1)}`,
      createdAt: 0,
      model: "m",
    });
    const state = {
      ...replayState([]),
      buffered: [chunk("live", ["a"]), chunk("stale", ["b", "gone"])],
    };
    const units = ["a", "b"].map((id) => describeUnit(id, "message", [user(id)], 10, true));
    const text = renderObserverContext(state, true, liveBufferedChunks(state, units));
    expect(text).toContain("live fact");
    expect(text).not.toContain("stale fact");
  });

  it("a buffered observer sees earlier buffered chunks as previous observations (Mastra async-buffer prepare)", async () => {
    let n = 0;
    registry.respond = () =>
      `<observations>\nDate: Nov 11, 2026\n* 🔴 (10:00) counted page ${++n}: 3 matches so far\n</observations>`;
    await toolStep(om, session, host, 7_000);
    await om.settled();
    await toolStep(om, session, host, 7_000);
    await om.settled();
    expect(replayState(session.getBranch(), []).activated).toHaveLength(0);
    expect(registry.calls[1]?.user).toContain("counted page 1: 3 matches so far");
  });

  it("A2: a run-start activation changes the prefix once, not on two consecutive requests", async () => {
    for (let step = 0; step < 7; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    // a second run whose request is observed and deferred, then buffered chunks and a TTL gap
    append(session, user("second task"));
    om.startRun(host);
    for (let step = 0; step < 3; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    append(session, assistantText("paused", { timestamp: Date.now() - 2 * 3_600_000 }));
    commit(
      session,
      await om.onTurnEnd({ contextEntries: session.buildSessionProjection().entries }, host),
    );
    append(session, user("third task"));
    om.startRun(host);
    const activationRequest = await request_(om);
    expect(om.events.some((e) => e.kind === "activate" && e.detail?.includes("ttl"))).toBe(true);
    const id = "after-activation";
    append(session, assistantToolCall(id, "read", { path: "x.ts" }));
    append(session, toolResult(id, "read", "small"));
    commit(
      session,
      await om.onTurnEnd({ contextEntries: session.buildSessionProjection().entries }, host),
    );
    const next = await request_(om);
    expect(JSON.stringify(next.slice(0, activationRequest.length))).toBe(
      JSON.stringify(activationRequest),
    );
  });
});
