import { describe, expect, it } from "vitest";
import { type ModelPolicy, packDefaults, selectModel } from "../model-policy.js";
import type { AgentConfig } from "../types.js";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "a",
    description: "d",
    systemPrompt: "",
    source: "user",
    filePath: "",
    ...overrides,
  };
}

const modes = {
  plan: "anthropic/claude-opus-5-5",
  build: "openai-codex/gpt-6.1-sol",
  fast: "anthropic/claude-fable-5-2",
};
const pack: ModelPolicy = { modes };
const verifier = agent({ name: "verifier", mode: "fast", packModel: true, independent: true });

describe("selectModel", () => {
  it("keeps task over agent over mode over session for ordinary agents", () => {
    const a = agent({ model: "x/agent", mode: "build" });
    expect(selectModel("x/task", a, pack)).toEqual({ ref: "x/task" });
    expect(selectModel(undefined, a, pack)).toEqual({ ref: "x/agent" });
    expect(selectModel(undefined, agent({ mode: "build" }), pack)).toEqual({ ref: modes.build });
    expect(selectModel(undefined, agent({ mode: "build" }), { modes: {} })).toEqual({
      ref: undefined,
    });
    expect(
      selectModel(undefined, agent({ mode: "plan" }), { modes: {}, defaults: () => modes }),
    ).toEqual({ ref: undefined });
  });

  it("runs a pack agent on its mode model, explicit before default, and reports an override", () => {
    const reviewer = agent({ name: "reviewer", mode: "plan", packModel: true, model: "x/file" });
    expect(selectModel("x/task", reviewer, pack)).toEqual({
      ref: modes.plan,
      ignored: "model x/task ignored: reviewer runs on the plan model",
    });
    expect(
      selectModel(undefined, agent({ mode: "plan", packModel: true }), {
        modes: {},
        defaults: () => ({ plan: "openai-codex/gpt-6.1-sol" }),
      }),
    ).toEqual({ ref: "openai-codex/gpt-6.1-sol" });
    expect(
      selectModel(undefined, agent({ mode: "plan", packModel: true }), {
        modes,
        defaults: () => ({ plan: "openai-codex/gpt-6.1-sol" }),
      }),
    ).toEqual({ ref: modes.plan });
  });

  it("rejects a pack agent with neither an explicit nor a default model", () => {
    expect(selectModel(undefined, verifier, { modes: { plan: modes.plan } })).toEqual({
      reject:
        "verifier runs on the fast model and no default is available; set pi-minions.modes.fast in settings.json",
    });
    expect(selectModel(undefined, agent({ name: "p", packModel: true }), pack)).toEqual({
      reject: "p runs on the model pack but sets no mode",
    });
  });

  it("rejects an independent agent on the writers' model: build, else the session model", () => {
    expect(selectModel(undefined, verifier, pack)).toEqual({ ref: modes.fast });
    expect(selectModel(undefined, verifier, { modes: { ...modes, fast: "gpt-6.1-sol" } })).toEqual({
      reject:
        "verifier would run on gpt-6.1-sol, the model writers use; set pi-minions.modes.fast to another model",
    });
    const sessionOnly = { modes: { fast: "anthropic/claude-sonnet-5-5" } };
    expect(
      selectModel(undefined, verifier, { ...sessionOnly, session: "anthropic/claude-sonnet-5-5" }),
    ).toMatchObject({ reject: expect.stringContaining("the model writers use") });
    expect(
      selectModel(undefined, verifier, { ...sessionOnly, session: "anthropic/claude-opus-5-5" }),
    ).toEqual({ ref: "anthropic/claude-sonnet-5-5" });
    expect(selectModel(undefined, verifier, sessionOnly)).toEqual({
      reject:
        "verifier must differ from the writers' model; set pi-minions.modes.build in settings.json",
    });
  });

  it("checks independence for agents outside the pack too", () => {
    const own = agent({ name: "judge", independent: true, model: "openai-codex/gpt-6.1-sol" });
    expect(selectModel(undefined, own, pack)).toEqual({
      reject:
        "judge would run on openai-codex/gpt-6.1-sol, the model writers use; set its model to another model",
    });
    expect(selectModel("anthropic/claude-fable-5-2", own, pack)).toEqual({
      ref: "anthropic/claude-fable-5-2",
    });
    expect(selectModel(undefined, agent({ name: "judge", independent: true }), pack)).toEqual({
      reject: "judge must run on a model other than the writers'; give it a mode or model",
    });
  });
});

const ANTHROPIC = [
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "anthropic", id: "claude-sonnet-5-5" },
];
const OPENAI = [
  { provider: "openai-codex", id: "gpt-6.1-sol" },
  { provider: "openai-codex", id: "gpt-6.1-terra" },
];
const PROXY = [{ provider: "opencode", id: "claude-opus-5-5" }];

describe("packDefaults", () => {
  it("with both families: terra verifies and the reviewer opposes the writers' family", () => {
    const available = [...ANTHROPIC, ...OPENAI];
    expect(packDefaults({ available, writers: ["openai-codex/gpt-6.1-sol"] })).toEqual({
      plan: "anthropic/claude-opus-5-5",
      fast: "openai-codex/gpt-6.1-terra",
    });
    expect(packDefaults({ available, writers: ["anthropic/claude-opus-5-5"] })).toEqual({
      plan: "openai-codex/gpt-6.1-sol",
      fast: "openai-codex/gpt-6.1-terra",
    });
    expect(
      packDefaults({
        available,
        writers: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol"],
      }),
    ).toMatchObject({ plan: "anthropic/claude-opus-5-5" });
  });

  it("with one family: Opus and Sonnet, or Sol and Terra", () => {
    expect(packDefaults({ available: ANTHROPIC, writers: [] })).toEqual({
      plan: "anthropic/claude-opus-5-5",
      fast: "anthropic/claude-sonnet-5-5",
    });
    expect(packDefaults({ available: OPENAI, writers: [] })).toEqual({
      plan: "openai-codex/gpt-6.1-sol",
      fast: "openai-codex/gpt-6.1-terra",
    });
  });

  it("counts only first-party providers and gives no default without one", () => {
    expect(packDefaults({ available: PROXY, writers: [] })).toEqual({});
    expect(
      packDefaults({ available: [{ provider: "openai", id: "gpt-6.1-sol" }], writers: [] }),
    ).toEqual({ plan: "openai/gpt-6.1-sol", fast: "openai/gpt-6.1-sol" });
  });
});
