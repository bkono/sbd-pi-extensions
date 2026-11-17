import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SessionOM } from "../runtime.js";
import { replayState } from "../state.js";
import {
  append,
  assistantText,
  config,
  fakeModel,
  fakeRegistry,
  makeHost,
  newSession,
  textOf,
  toolStep,
  user,
} from "./helpers.js";

describe("candidate main-model threshold calibration", () => {
  it.each([
    ["anthropic", "claude-opus-5-5", true],
    ["openai-codex", "gpt-6.1-sol", false],
  ])("buffers %s/%s at the effective interval", async (provider, id, buffers) => {
    const session = newSession();
    const registry = fakeRegistry();
    const host = makeHost(session, registry, { model: fakeModel(provider, id) });
    const om = new SessionOM(session.getSessionId(), config());
    append(session, user("fix auth"));
    om.startRun(host);
    try {
      await toolStep(om, session, host, 4_500);
      await om.settled();
      expect(registry.calls.length > 0).toBe(buffers);
      expect(om.snapshot(host).state.buffered.length > 0).toBe(buffers);
    } finally {
      om.dispose();
    }
  });

  it.each([
    ["anthropic", "claude-opus-5-5", true, 2],
    ["openai-codex", "gpt-6.1-sol", false, 1],
  ])("compacts %s/%s with its effective raw tail and batch size", async (provider, id, observesPenultimate, batches) => {
    const session = newSession();
    const registry = fakeRegistry([]);
    const host = makeHost(session, registry, { model: fakeModel(provider, id) });
    const om = new SessionOM(session.getSessionId(), config());
    append(session, user("fix auth"));
    const ids = Array.from({ length: 8 }, () => append(session, assistantText(textOf(1_500))));
    om.startRun(host);
    try {
      await om.onContext(host);
      registry.auth.add("openai-codex/gpt-6-luna");
      const result = await om.onCompact(host);
      expect(result).toBeDefined();
      om.onCompacted(host);
      const state = replayState(session.getBranch());
      expect(state.observedEntryIds.has(ids[6]!)).toBe(observesPenultimate);
      expect(state.observedEntryIds.has(ids[7]!)).toBe(false);
      expect(registry.calls).toHaveLength(batches);
    } finally {
      om.dispose();
    }
  });

  it.each([
    ["claude-opus-5-5", 21_429, 42_857],
  ])("activates %s before unchanged Sol at the same o200k count", async (id, threshold, blockAfter) => {
    for (const provider of ["anthropic", "openai-codex"]) {
      const session = newSession();
      const registry = fakeRegistry();
      const host = makeHost(session, registry, {
        model: fakeModel(provider, provider === "anthropic" ? id : "gpt-6.1-sol"),
      });
      const om = new SessionOM(session.getSessionId(), config());
      append(session, user("fix the auth bug"));
      om.startRun(host);
      try {
        for (let step = 0; step < 4; step += 1) {
          await toolStep(om, session, host, 6_000);
          await om.settled();
        }
        const activations = replayState(session.getBranch()).activated;
        expect(activations.length > 0).toBe(provider === "anthropic");
        expect(om.snapshot(host).status.threshold).toBe(
          provider === "anthropic" ? threshold : 30_000,
        );
        expect(om.snapshot(host).status.blockAfter).toBe(
          provider === "anthropic" ? blockAfter : 60_000,
        );
        expect(host.statuses.at(-1)).toContain(
          provider === "anthropic" ? `${(threshold / 1_000).toFixed(1)}k` : "30.0k",
        );
      } finally {
        om.dispose();
      }
    }
  });

  it("recomputes status on model switches without changing cached message counts", async () => {
    const session = newSession();
    const registry = fakeRegistry();
    const host = makeHost(session, registry);
    const om = new SessionOM(session.getSessionId(), config());
    append(session, user("a stable raw transcript"));
    om.startRun(host);
    try {
      const pending = om.snapshot(host).status.pendingTokens;
      for (const [provider, id, threshold] of [
        ["anthropic", "claude-opus-5-5", 21_429],
        ["anthropic", "claude-opus-4-6", 30_000],
        ["anthropic", "claude-sonnet-4-6", 30_000],
        ["openai-codex", "gpt-6.1-sol", 30_000],
      ] as const) {
        host.model = fakeModel(provider, id);
        await om.onContext(host);
        const status = om.snapshot(host).status;
        expect(status.threshold).toBe(threshold);
        expect(status.pendingTokens).toBe(pending);
      }
      host.model = undefined;
      expect(om.snapshot(host).status.threshold).toBe(30_000);
    } finally {
      om.dispose();
    }
  });

  it("activates buffered work when switching from Sol to a calibrated model", async () => {
    const session = newSession();
    const host = makeHost(session, fakeRegistry());
    const om = new SessionOM(session.getSessionId(), config());
    append(session, user("fix the auth bug"));
    om.startRun(host);
    try {
      for (let step = 0; step < 4; step += 1) {
        await toolStep(om, session, host, 6_000);
        await om.settled();
      }
      expect(om.events.some((event) => event.kind === "activate")).toBe(false);
      const pending = om.snapshot(host).status.pendingTokens;
      host.model = fakeModel("anthropic", "claude-opus-5-5");
      expect(om.snapshot(host).status.pendingTokens).toBe(pending);
      om.startRun(host);
      await om.onContext(host);
      expect(om.events.find((event) => event.kind === "activate")?.detail).toContain(
        "threshold 21429",
      );
      host.model = fakeModel("openai-codex", "gpt-6.1-sol");
      expect(om.snapshot(host).status.threshold).toBe(30_000);
    } finally {
      om.dispose();
    }
  });

  it("reports the effective threshold in activation events and JSONL traces", async () => {
    const directory = mkdtempSync(join(tmpdir(), "om-calibration-trace-"));
    const tracePath = join(directory, "events.jsonl");
    const session = newSession();
    const host = makeHost(session, fakeRegistry(), {
      model: fakeModel("anthropic", "claude-opus-5-5"),
    });
    const om = new SessionOM(session.getSessionId(), config({ tracePath }));
    append(session, user("fix the auth bug"));
    om.startRun(host);
    try {
      for (let step = 0; step < 6; step += 1) {
        await toolStep(om, session, host, 6_000);
        await om.settled();
      }
      const activation = om.events.find((event) => event.kind === "activate");
      expect(activation?.detail).toContain("threshold 21429");
      const lines = readFileSync(tracePath, "utf8").trim().split("\n");
      expect(
        lines.some(
          (line) => line.includes('"kind":"activate"') && line.includes("threshold 21429"),
        ),
      ).toBe(true);
    } finally {
      om.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
