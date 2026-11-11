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
    const sent: Awaited<ReturnType<typeof sentRequest>>[] = [];
    for (let i = 0; i < 16; i += 1) sent.push(await step(om, session, host, 6_000));
    let moves = 0;
    for (let i = 1; i < sent.length; i += 1) {
      const changed = !extends_(sent[i - 1]!.items, sent[i]!.items);
      expect({ request: i, moved: sent[i]!.signal?.moved }).toEqual({ request: i, moved: changed });
      if (changed) moves += 1;
    }
    expect(moves).toBeGreaterThan(0); // the run crossed at least one activation
    expect(sent[0]!.signal).toEqual({ moved: false });
  });

  it("reports moved after a compaction, a /tree move and a model switch", async () => {
    await sentRequest(om, session, host);
    expect(om.prefixSignal(host)).toEqual({ moved: false });
    om.onCompacted(host);
    expect(om.prefixSignal(host)).toEqual({ moved: true });
    expect(om.prefixSignal(host)).toEqual({ moved: false });
    om.onTreeChange(host);
    expect(om.prefixSignal(host)).toEqual({ moved: true });
    const switched = makeHost(session, registry, {
      model: fakeModel("anthropic", "claude-sonnet-5-5"),
    });
    expect(om.prefixSignal(switched)).toEqual({ moved: true });
    expect(om.prefixSignal(switched)).toEqual({ moved: false });
  });

  it("is silent when OM is off, so hashline masks on its own schedule", async () => {
    const offHost = makeHost(session, fakeRegistry([]));
    const off = new SessionOM(session.getSessionId(), config());
    await off.onContext(offHost);
    expect(off.prefixSignal(offHost)).toBeUndefined();
  });
});
