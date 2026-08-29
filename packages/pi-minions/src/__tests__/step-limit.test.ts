import { describe, expect, it, vi } from "vitest";
import {
  applyStepLimit,
  STEP_LIMIT_GRACE_TURNS,
  STEP_LIMIT_WRAP_UP_MESSAGE,
} from "../step-limit.js";

describe("applyStepLimit", () => {
  it("does nothing when steps is undefined", () => {
    const state = { reached: false };
    const steer = vi.fn(async () => {});
    const abort = vi.fn();

    expect(applyStepLimit({ count: 8, steps: undefined, state, steer, abort })).toBeUndefined();
    expect(state.reached).toBe(false);
    expect(steer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("steers wrap-up once at the limit and aborts after the grace turns", () => {
    const state = { reached: false };
    const steer = vi.fn(async () => {});
    const abort = vi.fn();
    const onWrapUp = vi.fn();
    const onAbort = vi.fn();
    const input = { steps: 1, state, steer, abort, onWrapUp, onAbort };

    expect(applyStepLimit({ ...input, count: 1 })).toBe("wrap-up");
    expect(state.reached).toBe(true);
    expect(onWrapUp).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(STEP_LIMIT_WRAP_UP_MESSAGE);
    expect(abort).not.toHaveBeenCalled();

    expect(applyStepLimit({ ...input, count: 1 })).toBeUndefined();
    expect(applyStepLimit({ ...input, count: 1 + STEP_LIMIT_GRACE_TURNS - 1 })).toBeUndefined();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();

    expect(applyStepLimit({ ...input, count: 1 + STEP_LIMIT_GRACE_TURNS })).toBe("abort");
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledTimes(1);
  });
});
