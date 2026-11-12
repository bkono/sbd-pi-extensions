import { describe, expect, it } from "vitest";
import { decideSettle, type Goal, MAX_CONTINUATIONS, type RepoState } from "../gate.js";

const goal: Goal = { predicate: "the bug is fixed", repos: [{ root: "/r", base: "aaa" }] };

function decide(
  states: RepoState[],
  overrides: { liveChildren?: number; continuations?: number } = {},
) {
  return decideSettle({
    goal,
    liveChildren: overrides.liveChildren ?? 0,
    continuations: overrides.continuations ?? 0,
    states: () => states,
  });
}

const failing: RepoState = {
  root: "/r",
  kind: "verdict",
  pass: false,
  sha: "bbb",
  line: "no passing verdict for bbb",
};

describe("decideSettle", () => {
  it("settles freely without a goal", () => {
    expect(
      decideSettle({ goal: undefined, liveChildren: 0, continuations: 0, states: () => [failing] }),
    ).toEqual({ kind: "settle" });
  });

  it("lets the lead yield while delegates are live, without looking at the repos", () => {
    let looked = false;
    const decision = decideSettle({
      goal,
      liveChildren: 2,
      continuations: 0,
      states: () => {
        looked = true;
        return [failing];
      },
    });
    expect(decision).toEqual({ kind: "settle" });
    expect(looked).toBe(false);
  });

  it("settles and keeps the goal while nothing is committed", () => {
    expect(decide([{ root: "/r", kind: "unchanged" }])).toEqual({ kind: "settle" });
  });

  it("is met when every new HEAD has a passing verdict", () => {
    const passing: RepoState = { ...failing, pass: true, line: "PASS bbb" };
    expect(decide([passing])).toEqual({ kind: "met" });
    expect(decide([passing, { root: "/s", kind: "unchanged" }])).toEqual({ kind: "met" });
  });

  it("continues with the reason while a verdict is missing or edits are uncommitted", () => {
    const decision = decide([failing, { root: "/s", kind: "uncommitted" }]);
    expect(decision.kind).toBe("continue");
    const message = "message" in decision ? decision.message : "";
    expect(message).toContain("the bug is fixed");
    expect(message).toContain("/r: no passing verdict for bbb");
    expect(message).toContain("/s: commits landed but changes are still uncommitted");
  });

  it("gives up after the continuation cap instead of looping", () => {
    expect(decide([failing], { continuations: MAX_CONTINUATIONS - 1 }).kind).toBe("continue");
    expect(decide([failing], { continuations: MAX_CONTINUATIONS }).kind).toBe("give-up");
  });
});
