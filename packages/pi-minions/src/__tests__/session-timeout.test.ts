import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installSessionTimeout,
  resolveEffectiveTimeout,
  TIMEOUT_GRACE_MS,
  TIMEOUT_WRAP_UP_MESSAGE,
} from "../session-timeout.js";

describe("resolveEffectiveTimeout", () => {
  it("prefers config timeout over env", () => {
    expect(resolveEffectiveTimeout(25, "99")).toBe(25);
  });

  it("parses env when config is unset and ignores invalid env", () => {
    expect(resolveEffectiveTimeout(undefined, "40")).toBe(40);
    expect(resolveEffectiveTimeout(undefined, "0")).toBeUndefined();
    expect(resolveEffectiveTimeout(undefined, "nope")).toBeUndefined();
    expect(resolveEffectiveTimeout(undefined, undefined)).toBeUndefined();
  });
});

describe("installSessionTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when timeout is undefined", () => {
    vi.useFakeTimers();
    const steer = vi.fn(async () => {});
    const abort = vi.fn();

    installSessionTimeout({ timeoutMs: undefined, steer, abort });
    vi.advanceTimersByTime(TIMEOUT_GRACE_MS + 1_000);

    expect(steer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("steers wrap-up at timeout then aborts after the grace period", () => {
    vi.useFakeTimers();
    const steer = vi.fn(async () => {});
    const abort = vi.fn();
    const onWrapUp = vi.fn();
    const onAbort = vi.fn();

    installSessionTimeout({ timeoutMs: 10, steer, abort, onWrapUp, onAbort });

    vi.advanceTimersByTime(9);
    expect(steer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onWrapUp).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(TIMEOUT_WRAP_UP_MESSAGE);
    expect(abort).not.toHaveBeenCalled();

    vi.advanceTimersByTime(TIMEOUT_GRACE_MS - 1);
    expect(abort).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it("clear after wrap-up prevents abort", () => {
    vi.useFakeTimers();
    const steer = vi.fn(async () => {});
    const abort = vi.fn();
    const timers = installSessionTimeout({ timeoutMs: 10, steer, abort });

    vi.advanceTimersByTime(10);
    expect(steer).toHaveBeenCalledTimes(1);
    timers.clear();
    vi.advanceTimersByTime(TIMEOUT_GRACE_MS);

    expect(abort).not.toHaveBeenCalled();
  });
});
