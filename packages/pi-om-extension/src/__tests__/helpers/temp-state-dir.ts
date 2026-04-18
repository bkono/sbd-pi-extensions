import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempStateDir {
  stateDir: string;
  cleanup: () => void;
}

export function createTempStateDir(): TempStateDir {
  const stateDir = mkdtempSync(join(tmpdir(), "om-test-"));
  return {
    stateDir,
    cleanup: () => {
      try {
        rmSync(stateDir, { recursive: true, force: true });
      } catch {
        // swallow — cleanup is best-effort
      }
    },
  };
}

/**
 * Build a minimal OMConfig pointing at a temp state dir, bypassing file-based
 * config loading. All tests that use runObservationCycle or the extension
 * should build their config this way to avoid touching the user's real
 * ~/.pi/om-config.json.
 */
export function createTestConfig(opts: {
  stateDir: string;
  observationTokens?: number;
  stagingTokens?: number;
  publishTokens?: number;
  reflectionTokens?: number;
  debug?: boolean;
}) {
  const stagingTokens = opts.stagingTokens ?? opts.observationTokens ?? 1000;
  const publishTokens = opts.publishTokens ?? opts.observationTokens ?? 1000;

  return {
    observation: {
      stageMessageTokens: stagingTokens,
      publishMessageTokens: publishTokens,
      provider: "google" as const,
      modelId: "gemini-2.5-flash",
    },
    reflection: {
      observationTokens: opts.reflectionTokens ?? 5000,
      provider: "google" as const,
      modelId: "gemini-2.5-flash",
    },
    storage: {
      stateDir: opts.stateDir,
    },
    debug: opts.debug ?? false,
  };
}
