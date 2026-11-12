import { describe, expect, it } from "vitest";
import { selectModel } from "../model-policy.js";
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

describe("selectModel", () => {
  it("keeps task over agent over mode over session for ordinary agents", () => {
    const a = agent({ model: "x/agent", mode: "build" });
    expect(selectModel("x/task", a, modes)).toEqual({ ref: "x/task" });
    expect(selectModel(undefined, a, modes)).toEqual({ ref: "x/agent" });
    expect(selectModel(undefined, agent({ mode: "build" }), modes)).toEqual({
      ref: modes.build,
    });
    expect(selectModel(undefined, agent({ mode: "build" }), {})).toEqual({ ref: undefined });
    expect(selectModel(undefined, agent(), modes)).toEqual({ ref: undefined });
  });

  it("runs a pack agent on its mode model and reports an ignored override", () => {
    const reviewer = agent({ name: "reviewer", mode: "plan", packModel: true, model: "x/file" });
    expect(selectModel("x/task", reviewer, modes)).toEqual({
      ref: modes.plan,
      ignored: "model x/task ignored: reviewer runs on the plan model",
    });
    expect(selectModel(undefined, agent({ mode: "plan", packModel: true }), modes)).toEqual({
      ref: modes.plan,
    });
  });

  it("rejects a pack agent whose mode is not configured", () => {
    const verifier = agent({ name: "verifier", mode: "fast", packModel: true });
    expect(selectModel(undefined, verifier, { plan: modes.plan })).toEqual({
      reject: "verifier runs on the fast model; set pi-minions.modes.fast in settings.json",
    });
    expect(selectModel(undefined, agent({ name: "p", packModel: true }), modes)).toEqual({
      reject: "p runs on the model pack but sets no mode",
    });
  });

  it("rejects an independent agent that would share the writers' build model", () => {
    const verifier = agent({ name: "verifier", mode: "fast", packModel: true, independent: true });
    expect(selectModel(undefined, verifier, modes)).toEqual({ ref: modes.fast });
    expect(selectModel(undefined, verifier, { ...modes, fast: "gpt-6.1-sol" })).toEqual({
      reject:
        "verifier would run on gpt-6.1-sol, the build model writers use; set pi-minions.modes.fast to another model",
    });
    expect(selectModel(undefined, verifier, { fast: modes.fast })).toEqual({
      reject:
        "verifier must differ from the writers' model; set pi-minions.modes.build in settings.json",
    });
  });

  it("checks independence for agents outside the pack too", () => {
    const own = agent({ name: "judge", independent: true, model: "openai-codex/gpt-6.1-sol" });
    expect(selectModel(undefined, own, modes)).toEqual({
      reject:
        "judge would run on openai-codex/gpt-6.1-sol, the build model writers use; set its model to another model",
    });
    expect(selectModel("anthropic/claude-fable-5-2", own, modes)).toEqual({
      ref: "anthropic/claude-fable-5-2",
    });
    expect(selectModel(undefined, agent({ name: "judge", independent: true }), modes)).toEqual({
      reject: "judge must run on a model other than the build model; give it a mode or model",
    });
  });
});
