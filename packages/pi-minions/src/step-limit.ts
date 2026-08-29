export const STEP_LIMIT_WRAP_UP_MESSAGE =
  "STEP LIMIT REACHED. You have used all allocated steps. " +
  "Wrap up now — summarize your progress and deliver your findings. " +
  "You have 2 more turns to finish.";

export const STEP_LIMIT_GRACE_TURNS = 2;

export interface StepLimitState {
  reached: boolean;
}

export interface ApplyStepLimitInput {
  count: number;
  steps: number | undefined;
  state: StepLimitState;
  steer: (text: string) => Promise<void> | undefined | void;
  abort: () => void;
  onWrapUp?: () => void;
  onAbort?: () => void;
}

/**
 * One-shot wrap-up at `steps`, then force-abort after `steps + 2` turns.
 * Returns the action taken, if any.
 */
export function applyStepLimit(input: ApplyStepLimitInput): "wrap-up" | "abort" | undefined {
  const { count, steps, state } = input;
  if (steps === undefined) return undefined;

  if (count >= steps && !state.reached) {
    state.reached = true;
    input.onWrapUp?.();
    void Promise.resolve(input.steer(STEP_LIMIT_WRAP_UP_MESSAGE)).catch(() => {});
    return "wrap-up";
  }

  if (state.reached && count > steps + STEP_LIMIT_GRACE_TURNS) {
    input.onAbort?.();
    input.abort();
    return "abort";
  }

  return undefined;
}
