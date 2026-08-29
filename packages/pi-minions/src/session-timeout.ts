export const TIMEOUT_WRAP_UP_MESSAGE =
  "TIMEOUT REACHED. Your time allocation has expired. " +
  "Summarize your progress and findings now. Do NOT make any more tool calls. " +
  "This is your last turn.";

export const TIMEOUT_GRACE_MS = 30_000;

export interface SessionTimeoutTimers {
  clear(): void;
}

export interface InstallSessionTimeoutInput {
  timeoutMs: number | undefined;
  steer: (text: string) => Promise<void> | undefined | void;
  abort: () => void;
  onWrapUp?: () => void;
  onAbort?: () => void;
}

/** Role timeout, else `PI_MINIONS_TIMEOUT` env. Invalid/zero env values are ignored. */
export function resolveEffectiveTimeout(
  configTimeout: number | undefined,
  envValue: string | undefined = process.env.PI_MINIONS_TIMEOUT,
): number | undefined {
  return configTimeout ?? (envValue ? parseInt(envValue, 10) || undefined : undefined);
}

/**
 * Steer a wrap-up at `timeoutMs`, then force-abort after {@link TIMEOUT_GRACE_MS}.
 * `clear()` cancels both timers. No-op when `timeoutMs` is undefined.
 */
export function installSessionTimeout(input: InstallSessionTimeoutInput): SessionTimeoutTimers {
  const { timeoutMs } = input;
  if (timeoutMs === undefined) {
    return { clear() {} };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let graceTimeoutId: ReturnType<typeof setTimeout> | undefined;

  timeoutId = setTimeout(() => {
    input.onWrapUp?.();
    void Promise.resolve(input.steer(TIMEOUT_WRAP_UP_MESSAGE)).catch(() => {});
    graceTimeoutId = setTimeout(() => {
      input.onAbort?.();
      input.abort();
    }, TIMEOUT_GRACE_MS);
  }, timeoutMs);

  return {
    clear() {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (graceTimeoutId !== undefined) clearTimeout(graceTimeoutId);
      timeoutId = undefined;
      graceTimeoutId = undefined;
    },
  };
}
