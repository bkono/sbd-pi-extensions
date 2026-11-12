import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";

import { PREFIX_SIGNAL_CHANNEL, SessionOM, type SessionOM as SessionOMType } from "../runtime.js";
import {
  append,
  assistantToolCall,
  commit,
  config,
  contextMessages,
  type FakeRegistry,
  fakeModel,
  fakeRegistry,
  makeHost,
  newSession,
  systemMessages,
  textOf,
  tick,
  toolResult,
  user,
} from "./helpers.js";

/**
 * The prefix signal tells other context rewriters (hashline's stale masks) whether this
 * request's cached prefix moves anyway. It must match what OM actually sends: true exactly
 * when the rendered request is not an append-only extension of the previous one.
 */
async function sentRequest(
  om: SessionOMType,
  session: SessionManager,
  host: ReturnType<typeof makeHost>,
) {
  await om.onContext(host);
  const signal = om.prefixSignal(host);
  const full = [...systemMessages(), ...contextMessages(session)];
  const out = (om.onSystem(full, host) ?? full) as AgentMessage[];
  return { signal, items: out.map((message) => JSON.stringify(message)) };
}

/**
 * The next local 23:00 after the helpers' message clock. Messages are stamped from that
 * clock, so the host clock must start from it, not from a fixed date: a fixed date makes the
 * TTL check depend on the wall clock (it read negative idle time once the date passed).
 */
function next2300(): number {
  const at = new Date(tick(0));
  const start = new Date(at);
  start.setHours(23, 0, 0, 0);
  if (start.getTime() <= at.getTime()) start.setDate(start.getDate() + 1);
  return start.getTime();
}

function extends_(previous: readonly string[], next: readonly string[]): boolean {
  return next.length >= previous.length && previous.every((item, i) => next[i] === item);
}

let seq = 0;
async function step(
  om: SessionOMType,
  session: SessionManager,
  host: ReturnType<typeof makeHost>,
  tokens: number,
) {
  const sent = await sentRequest(om, session, host);
  const id = `sig-${++seq}`;
  append(session, assistantToolCall(id, "read", { path: `src/sig-${seq}.ts` }));
  append(session, toolResult(id, "read", textOf(tokens)));
  commit(
    session,
    await om.onTurnEnd({ contextEntries: session.buildSessionProjection().entries }, host),
  );
  await om.settled();
  return sent;
}

describe("prefix signal", () => {
  let session: SessionManager;
  let registry: FakeRegistry;
  let host: ReturnType<typeof makeHost>;
  let om: SessionOMType;

  beforeEach(() => {
    session = newSession();
    registry = fakeRegistry();
    host = makeHost(session, registry);
    om = new SessionOM(session.getSessionId(), config());
    append(session, user("count the pages"));
    om.startRun(host);
  });

  it("is the literal hashline listens on", () => {
    expect(PREFIX_SIGNAL_CHANNEL).toBe("context:prefix");
  });

  it("reports moved exactly on the requests whose prefix changes", async () => {
    // A moving clock that crosses midnight, a second run after a 2h idle (TTL activation at
    // run start, temporal gap marker), and threshold activations in both runs.
    let now = next2300();
    const clocked = makeHost(session, registry, { now: () => now });
    const sent: Awaited<ReturnType<typeof sentRequest>>[] = [];
    for (let i = 0; i < 12; i += 1) {
      sent.push(await step(om, session, clocked, 6_000));
      now += 4 * 60_000;
    }
    now += 2 * 60 * 60_000;
    append(session, user("now count the queue steps"));
    om.startRun(clocked);
    for (let i = 0; i < 10; i += 1) {
      sent.push(await step(om, session, clocked, 6_000));
      now += 4 * 60_000;
    }
    let moves = 0;
    for (let i = 1; i < sent.length; i += 1) {
      const changed = !extends_(sent[i - 1]!.items, sent[i]!.items);
      expect({ request: i, moved: sent[i]!.signal?.moved }).toEqual({ request: i, moved: changed });
      if (changed) moves += 1;
    }
    expect(moves).toBeGreaterThan(1);
    expect(om.events.some((e) => e.kind === "activate" && e.detail?.includes("ttl"))).toBe(true);
    expect(sent[0]!.signal).toEqual({ moved: false });
  });

  it("reports no move at midnight while there is no memory to render", async () => {
    let now = next2300() + 59 * 60_000;
    const clocked = makeHost(session, registry, { now: () => now });
    const before = await sentRequest(om, session, clocked);
    now += 2 * 60_000;
    const after = await sentRequest(om, session, clocked);
    expect(after.items).toEqual(before.items);
    expect(after.signal).toEqual({ moved: false });
  });

  it("reports moved after a compaction and a model switch, but not for /tree alone", async () => {
    await sentRequest(om, session, host);
    expect(om.prefixSignal(host)).toEqual({ moved: false });
    om.onCompacted(host);
    expect(om.prefixSignal(host)).toEqual({ moved: true });
    expect(om.prefixSignal(host)).toEqual({ moved: false });
    // the shared ancestor prefix stays cached across a /tree move
    om.onTreeChange(host);
    expect(om.prefixSignal(host)).toEqual({ moved: false });
    const switched = makeHost(session, registry, {
      model: fakeModel("anthropic", "claude-sonnet-5-5"),
    });
    expect(om.prefixSignal(switched)).toEqual({ moved: true });
    expect(om.prefixSignal(switched)).toEqual({ moved: false });
  });

  it("keeps tracking while off, so re-enabling reports no stale move", async () => {
    await sentRequest(om, session, host);
    expect(om.prefixSignal(host)).toEqual({ moved: false });
    const offHost = makeHost(session, fakeRegistry([]));
    expect(om.prefixSignal(offHost)).toBeUndefined();
    om.onCompacted(host); // a move during the off window is consumed there
    expect(om.prefixSignal(offHost)).toBeUndefined();
    expect(om.prefixSignal(host)).toEqual({ moved: false });
  });

  it("is silent when OM is off, so hashline masks on its own schedule", async () => {
    const offHost = makeHost(session, fakeRegistry([]));
    const off = new SessionOM(session.getSessionId(), config());
    await off.onContext(offHost);
    expect(off.prefixSignal(offHost)).toBeUndefined();
  });
});
