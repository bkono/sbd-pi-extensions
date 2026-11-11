import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";

import { OM_SECTION } from "../context.js";
import { type Host, SessionOM } from "../runtime.js";
import { OM_ACTIVATION, OM_CHUNK, OM_REFLECTION, replayState } from "../state.js";
import {
  append,
  assistantText,
  assistantToolCall,
  commit,
  config,
  contextMessages,
  deferred,
  type FakeRegistry,
  fakeModel,
  fakeRegistry,
  makeHost,
  newSession,
  OBSERVATION_RESPONSE,
  request,
  systemMessages,
  textOf,
  toolResult,
  toolStep,
  user,
  words,
} from "./helpers.js";

function omSection(om: SessionOM, host: Host): string | undefined {
  const out = om.onSystem(systemMessages(), host);
  return (out?.[0] as { sections?: Record<string, string> } | undefined)?.sections?.[OM_SECTION];
}

function customTypes(drafts: readonly { type: string; customType?: string }[]): string[] {
  return drafts.filter((d) => d.type === "custom").map((d) => d.customType!);
}

describe("SessionOM", () => {
  let session: SessionManager;
  let registry: FakeRegistry;
  let host: ReturnType<typeof makeHost>;
  let om: SessionOM;

  beforeEach(() => {
    session = newSession();
    registry = fakeRegistry();
    host = makeHost(session, registry);
    om = new SessionOM(session.getSessionId(), config());
    append(session, user("fix the auth bug"));
    om.startRun(host);
  });

  it("never waits on the observer below blockAfter, even when it hangs (P1)", async () => {
    const hang = deferred<string>();
    registry.respond = () => hang.promise;
    let worst = 0;
    for (let step = 0; step < 9; step += 1) {
      const started = performance.now();
      await toolStep(om, session, host, 6_000);
      worst = Math.max(worst, performance.now() - started);
    }
    const snapshot = om.snapshot(host);
    expect(snapshot.status.pendingTokens).toBeGreaterThan(50_000);
    expect(snapshot.status.mustBlock).toBe(false);
    expect(snapshot.bufferInFlight).toBe(true);
    expect(worst).toBeLessThan(250); // token counting only; no model call on the critical path
    hang.resolve(OBSERVATION_RESPONSE);
    await om.settled();
  });

  it("buffers in the background and activates in the band with context edits (P3)", async () => {
    const resultIds: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      const { resultEntryId } = await toolStep(om, session, host, 6_000);
      resultIds.push(resultEntryId);
      await om.settled();
    }
    // chunks were committed at boundaries
    const types = session
      .getBranch()
      .filter((e) => e.type === "custom")
      .map((e) => (e as { customType: string }).customType);
    expect(types).toContain(OM_CHUNK);
    expect(types).toContain(OM_ACTIVATION);

    const state = replayState(session.getBranch());
    expect(state.activated.length).toBeGreaterThan(0);
    // every observed entry is omitted from model context by a context edit
    const projected = new Set(
      session
        .buildSessionProjection()
        .entries.filter((e) => e.messages.length > 0)
        .map((e) => e.sourceEntry.id),
    );
    for (const entryId of state.observedEntryIds) expect(projected.has(entryId)).toBe(false);
    // the latest tool result was never read by the model, so it is still in context
    expect(projected.has(resultIds.at(-1)!)).toBe(true);
    // the observer saw tool arguments
    expect(registry.calls.some((call) => call.user.includes('"path":"src/file-'))).toBe(true);
    // pending dropped back near the retention floor plus the newest unread work
    expect(om.snapshot(host).status.pendingTokens).toBeLessThan(30_000);
  });

  it("keeps the OM section byte-stable between activations (P4)", async () => {
    for (let step = 0; step < 6; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    const first = omSection(om, host);
    expect(first).toBeDefined();
    const activationsBefore = replayState(session.getBranch()).activated.length;
    // small steps below every threshold: no activation, no reflection
    for (let step = 0; step < 3; step += 1) {
      await toolStep(om, session, host, 200);
      expect(omSection(om, host)).toBe(first);
    }
    expect(replayState(session.getBranch()).activated.length).toBe(activationsBefore);
  });

  it("activates buffered chunks at run start once the cache TTL has expired (P5)", async () => {
    // 18k of history, buffered but below the 30k threshold, last reply 2h ago
    for (let step = 0; step < 3; step += 1) await toolStep(om, session, host, 6_000);
    await om.settled();
    append(session, assistantText("done for now", { timestamp: Date.now() - 2 * 60 * 60 * 1_000 }));
    await om.onSettle({ contextEntries: session.buildSessionProjection().entries }, host);
    await om.settled();
    commit(
      session,
      await om.onTurnEnd({ contextEntries: session.buildSessionProjection().entries }, host),
    );
    const bufferedBefore = replayState(session.getBranch()).buffered.length;
    expect(bufferedBefore).toBeGreaterThan(0);
    expect(om.snapshot(host).status.shouldObserve).toBe(false);

    append(session, user("back from my meeting"));
    om.startRun(host);
    const before = contextMessages(session).length;
    const sent = await request(om, session, host);
    // continuation reminder + fewer raw messages
    expect((sent[0] as { content?: unknown }).content).toEqual(
      expect.stringContaining("system-reminder"),
    );
    expect(sent.length - 1).toBeLessThan(before);
    expect(om.events.some((e) => e.kind === "activate" && e.detail?.includes("ttl"))).toBe(true);
  });

  it("does not activate below threshold while the cache is warm", async () => {
    for (let step = 0; step < 3; step += 1) await toolStep(om, session, host, 6_000);
    await om.settled();
    append(session, assistantText("done for now"));
    commit(
      session,
      await om.onTurnEnd({ contextEntries: session.buildSessionProjection().entries }, host),
    );
    append(session, user("one more thing"));
    om.startRun(host);
    const before = contextMessages(session);
    const sent = await request(om, session, host);
    expect(sent.length).toBe(before.length);
    expect(om.events.some((e) => e.kind === "activate")).toBe(false);
  });

  it("activates on a provider change at run start", async () => {
    for (let step = 0; step < 3; step += 1) await toolStep(om, session, host, 6_000);
    await om.settled();
    append(session, assistantText("done", { provider: "openai-codex" }));
    commit(
      session,
      await om.onTurnEnd({ contextEntries: session.buildSessionProjection().entries }, host),
    );
    append(session, user("switching models"));
    const anthropicHost = makeHost(session, registry, {
      model: fakeModel("anthropic", "claude-opus-5-5"),
    });
    om.startRun(anthropicHost);
    await request(om, session, anthropicHost);
    expect(
      om.events.some((e) => e.kind === "activate" && e.detail?.includes("provider_change")),
    ).toBe(true);
  });

  it("blocks only at blockAfter, then observes synchronously and activates", async () => {
    // one huge read jumps straight past 60k with nothing buffered yet
    const hang = deferred<string>();
    registry.respond = () => hang.promise;
    await toolStep(om, session, host, 3_000);
    registry.respond = () => OBSERVATION_RESPONSE;
    hang.resolve(OBSERVATION_RESPONSE);
    await om.settled();
    await request(om, session, host);
    const id = "call-big";
    const assistantEntryId = append(session, assistantToolCall(id, "read", { path: "big.log" }));
    append(session, toolResult(id, "read", textOf(62_000)));
    await request(om, session, host); // the model reads the big result
    const nextId = "call-after";
    const nextAssistant = append(session, assistantToolCall(nextId, "grep", { q: "x" }));
    append(session, toolResult(nextId, "grep", "no matches"));
    expect(nextAssistant).toBeTruthy();
    const drafts = await om.onTurnEnd(
      { contextEntries: session.buildSessionProjection().entries },
      host,
    );
    commit(session, drafts);
    expect(om.events.some((e) => e.kind === "block")).toBe(true);
    expect(customTypes(drafts)).toContain(OM_ACTIVATION);
    expect(om.snapshot(host).status.mustBlock).toBe(false);
    expect(assistantEntryId).toBeTruthy();
  });

  it("buffers a reflection from 20k observation tokens and swaps it in at 40k", async () => {
    const bigObservations = `<observations>\nDate: Nov 11, 2026\n${Array.from({ length: 600 }, (_, i) => `* 🟡 (10:${String(i % 60).padStart(2, "0")}) Agent learned fact ${i}: ${words(8)}`).join("\n")}\n</observations>`;
    registry.respond = (context) =>
      String(context.systemPrompt).includes("observation reflector")
        ? "<observations>\nDate: Nov 11, 2026\n* 🔴 (10:00) Consolidated memory\n</observations>"
        : bigObservations;
    for (let step = 0; step < 14; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    expect(om.events.some((e) => e.kind === "reflect-buffer")).toBe(true);
    expect(om.events.some((e) => e.kind === "reflect-activate")).toBe(true);
    const state = replayState(session.getBranch());
    expect(state.generation).toBeGreaterThan(0);
    expect(state.reflection?.observations).toContain("Consolidated memory");
    expect(
      session
        .getBranch()
        .some(
          (e) => e.type === "custom" && (e as { customType: string }).customType === OM_REFLECTION,
        ),
    ).toBe(true);
  });

  it("restores state from the session after a restart", async () => {
    for (let step = 0; step < 6; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    const section = omSection(om, host);
    om.dispose();
    const restarted = new SessionOM(session.getSessionId(), config());
    restarted.startRun(host);
    await restarted.onContext(host);
    expect(omSection(restarted, host)).toBe(section);
  });

  it("replaces Pi's summarizer on compaction, keeping from the first unobserved entry", async () => {
    for (let step = 0; step < 4; step += 1) {
      await toolStep(om, session, host, 6_000);
      await om.settled();
    }
    await request(om, session, host);
    const result = await om.onCompact(host);
    expect(result).toBeDefined();
    om.onCompacted(host); // Pi's session_compact after the compaction entry lands
    const state = replayState(session.getBranch());
    expect(state.observedEntryIds.has(result!.firstKeptEntryId)).toBe(false);
    // everything before the kept raw tail is in memory
    const units = session.buildSessionProjection().entries.filter((e) => e.messages.length > 0);
    const keptIndex = units.findIndex((e) => e.sourceEntry.id === result!.firstKeptEntryId);
    expect(keptIndex).toBeGreaterThan(0);
    for (const entry of units.slice(1, keptIndex))
      expect(state.observedEntryIds.has(entry.sourceEntry.id)).toBe(true);
  });

  it("turns itself off with a reason when no model is available", async () => {
    const offRegistry = fakeRegistry([]);
    const offHost = makeHost(session, offRegistry);
    const off = new SessionOM(session.getSessionId(), config());
    off.startRun(offHost);
    await request(off, session, offHost);
    expect(offRegistry.calls).toHaveLength(0);
    expect(offHost.statuses.at(-1)).toMatch(/paused · no observer model/);
  });
});
