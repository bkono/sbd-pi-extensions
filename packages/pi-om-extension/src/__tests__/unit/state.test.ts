import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionStatePath } from "../../config.js";
import { createDefaultState, loadSessionState, saveSessionState } from "../../state.js";
import type { SessionState } from "../../types.js";
import { createTempStateDir } from "../helpers/temp-state-dir.js";

describe("createDefaultState", () => {
  it("returns a state with sessionId and empty observations", () => {
    const state = createDefaultState("sess-1");
    expect(state.sessionId).toBe("sess-1");
    expect(state.observations).toBe("");
    expect(state.observationTokens).toBe(0);
    expect(state.draftObservations).toBe("");
    expect(state.draftObservationTokens).toBe(0);
    expect(state.updatedAt).toBeGreaterThan(0);
  });
});

describe("loadSessionState / saveSessionState", () => {
  let stateDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const temp = createTempStateDir();
    stateDir = temp.stateDir;
    cleanup = temp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it("returns default state when file does not exist", async () => {
    const state = await loadSessionState(stateDir, "missing-session");
    expect(state.sessionId).toBe("missing-session");
    expect(state.observations).toBe("");
  });

  it("round-trips a state via save → load", async () => {
    const original: SessionState = {
      sessionId: "rt-1",
      observations: "* 🔴 some observation",
      observationTokens: 42,
      lastObservedEntryId: "entry-5",
      lastObservedTimestamp: 1_700_000_000_000,
      currentTask: "building tests",
      suggestedResponse: "continue",
      draftObservations: "* 🔴 staged observation",
      draftObservationTokens: 84,
      draftLastObservedEntryId: "entry-7",
      draftLastObservedTimestamp: 1_700_000_002_000,
      draftCurrentTask: "staging tests",
      draftSuggestedResponse: "publish later",
      lastCycleAt: 1_700_000_500_000,
      lastCycleReason: "turn_end",
      lastCursorMode: "id",
      updatedAt: 0,
    };
    await saveSessionState(stateDir, original);
    const loaded = await loadSessionState(stateDir, "rt-1");
    expect(loaded.sessionId).toBe("rt-1");
    expect(loaded.observations).toBe("* 🔴 some observation");
    expect(loaded.observationTokens).toBe(42);
    expect(loaded.lastObservedEntryId).toBe("entry-5");
    expect(loaded.currentTask).toBe("building tests");
    expect(loaded.draftObservations).toBe("* 🔴 staged observation");
    expect(loaded.draftObservationTokens).toBe(84);
    expect(loaded.draftLastObservedEntryId).toBe("entry-7");
    expect(loaded.draftCurrentTask).toBe("staging tests");
    expect(loaded.draftSuggestedResponse).toBe("publish later");
    expect(loaded.lastCursorMode).toBe("id");
    expect(loaded.updatedAt).toBeGreaterThan(0);
  });

  it("updatedAt is refreshed on save", async () => {
    const state: SessionState = {
      sessionId: "time-test",
      observations: "",
      observationTokens: 0,
      draftObservations: "",
      draftObservationTokens: 0,
      updatedAt: 1, // stale
    };
    await saveSessionState(stateDir, state);
    const loaded = await loadSessionState(stateDir, "time-test");
    expect(loaded.updatedAt).toBeGreaterThan(1);
  });

  it("returns default on corrupt JSON", async () => {
    const path = sessionStatePath(stateDir, "corrupt");
    writeFileSync(path, "{ not valid json");
    const state = await loadSessionState(stateDir, "corrupt");
    expect(state.sessionId).toBe("corrupt");
    expect(state.observations).toBe("");
  });

  it("always uses the requested sessionId, ignoring the one on disk", async () => {
    const path = sessionStatePath(stateDir, "real-id");
    writeFileSync(
      path,
      JSON.stringify({
        sessionId: "malicious-id",
        observations: "",
        observationTokens: 0,
        updatedAt: 1,
      }),
    );
    const state = await loadSessionState(stateDir, "real-id");
    expect(state.sessionId).toBe("real-id");
  });

  it("rejects invalid lastCursorMode and leaves it undefined", async () => {
    const path = sessionStatePath(stateDir, "invalid-mode");
    writeFileSync(
      path,
      JSON.stringify({
        sessionId: "invalid-mode",
        observations: "",
        observationTokens: 0,
        lastCursorMode: "not-a-mode",
        updatedAt: 1,
      }),
    );
    const state = await loadSessionState(stateDir, "invalid-mode");
    expect(state.lastCursorMode).toBeUndefined();
  });

  it("fills missing fields with defaults for partial state", async () => {
    const path = sessionStatePath(stateDir, "partial");
    writeFileSync(
      path,
      JSON.stringify({
        sessionId: "partial",
        observations: "hello",
      }),
    );
    const state = await loadSessionState(stateDir, "partial");
    expect(state.observations).toBe("hello");
    expect(state.observationTokens).toBe(0); // defaulted
    expect(state.draftObservations).toBe("hello");
    expect(state.draftObservationTokens).toBe(0);
    expect(state.updatedAt).toBeGreaterThan(0); // defaulted to now
  });

  it("coerces non-numeric observationTokens to default", async () => {
    const path = sessionStatePath(stateDir, "bad-tokens");
    writeFileSync(
      path,
      JSON.stringify({
        sessionId: "bad-tokens",
        observations: "",
        observationTokens: "not-a-number",
        updatedAt: 1,
      }),
    );
    const state = await loadSessionState(stateDir, "bad-tokens");
    expect(state.observationTokens).toBe(0);
    expect(state.draftObservationTokens).toBe(0);
  });

  it("defaults staged draft fields from the published state for legacy files", async () => {
    const path = sessionStatePath(stateDir, "legacy");
    writeFileSync(
      path,
      JSON.stringify({
        sessionId: "legacy",
        observations: "* published",
        observationTokens: 12,
        lastObservedEntryId: "entry-2",
        lastObservedTimestamp: 1_700_000_000_000,
        currentTask: "published task",
        suggestedResponse: "published response",
        updatedAt: 1,
      }),
    );

    const state = await loadSessionState(stateDir, "legacy");

    expect(state.draftObservations).toBe("* published");
    expect(state.draftObservationTokens).toBe(12);
    expect(state.draftLastObservedEntryId).toBe("entry-2");
    expect(state.draftLastObservedTimestamp).toBe(1_700_000_000_000);
    expect(state.draftCurrentTask).toBe("published task");
    expect(state.draftSuggestedResponse).toBe("published response");
  });
});
