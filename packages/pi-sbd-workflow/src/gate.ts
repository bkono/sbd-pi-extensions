/**
 * The done gate. Pi has no goal judge, so "done" is checked mechanically at
 * `agent_before_settle`: a repository the goal covers that gained commits needs a passing
 * independent verdict at HEAD before the session may settle.
 */

export interface GoalRepo {
  root: string;
  /** HEAD when the goal was set. A repository still at its base shipped no commits. */
  base: string;
  /** Uncommitted changes existed when the goal was set, so they are not this goal's to commit. */
  dirtyAtStart?: boolean;
}

export interface Goal {
  predicate: string;
  repos: GoalRepo[];
}

/** What the gate observed in one repository at settle time. */
export type RepoState =
  | { root: string; kind: "unchanged" }
  | { root: string; kind: "uncommitted" }
  | { root: string; kind: "verdict"; pass: boolean; line: string; sha: string };

export type GateDecision =
  | { kind: "settle" }
  | { kind: "met" }
  | { kind: "continue"; message: string }
  | { kind: "give-up"; message: string };

export const MAX_CONTINUATIONS = 3;

function unmet(state: RepoState): string | undefined {
  if (state.kind === "uncommitted") {
    return `${state.root}: commits landed but changes are still uncommitted. Commit them, then have the verifier check that SHA.`;
  }
  if (state.kind === "verdict" && !state.pass) {
    return `${state.root}: ${state.line}. Dispatch the verifier on ${state.sha}; only its sbd_verdict_post counts.`;
  }
  return undefined;
}

export function decideSettle(input: {
  goal: Goal | undefined;
  liveChildren: number;
  continuations: number;
  states: () => RepoState[];
}): GateDecision {
  const { goal } = input;
  if (!goal) return { kind: "settle" };
  // Yielding while delegates run is supervision, not "done". Their packets wake the lead.
  if (input.liveChildren > 0) return { kind: "settle" };
  // After giving up, stay quiet until the user speaks and resets the count.
  if (input.continuations > MAX_CONTINUATIONS) return { kind: "settle" };
  const states = input.states();
  const problems = states.map(unmet).filter((line): line is string => line !== undefined);
  if (problems.length === 0) {
    // Nothing shipped yet (a question, a pause, an investigation): settle and keep the goal.
    return states.every((state) => state.kind === "unchanged")
      ? { kind: "settle" }
      : { kind: "met" };
  }
  if (input.continuations >= MAX_CONTINUATIONS) {
    return {
      kind: "give-up",
      message: [
        `sbd gate: the goal is still not met after ${MAX_CONTINUATIONS} continuations, so the session settles. Done is not claimed, and the goal stays set.`,
        ...problems.map((line) => `- ${line}`),
      ].join("\n"),
    };
  }
  return {
    kind: "continue",
    message: [
      `sbd gate: the goal is not met, so the session does not settle yet. Goal: ${goal.predicate}`,
      ...problems.map((line) => `- ${line}`),
      "Finish the work, or tell the user what blocks it.",
    ].join("\n"),
  };
}
