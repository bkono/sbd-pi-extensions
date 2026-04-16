import type { BeadworkConfig, SessionState } from "./types.js";

export const EXTENSION_ID = "beadwork";
export const COMMAND_NAME = "bw";
export const DEFAULT_BEADWORK_BRANCH = "beadwork";

export const DEFAULT_SESSION_STATE: SessionState = {
  mode: "neutral",
  scope: { kind: "none" },
  updatedAt: new Date(0).toISOString(),
};

export const DEFAULT_CONFIG: BeadworkConfig = {
  ui: {
    showInactiveStatus: false,
  },
  storage: {
    sessionStateDir: ".pi/beadwork/session-state",
    workerRegistryFile: ".pi/beadwork/workers/registry.json",
    runtimeDir: ".pi/beadwork/workers/runtime",
  },
  tmux: {
    sessionName: "pi-bw",
    workerCommand: "pi",
    workerProvider: undefined,
    workerModel: undefined,
  },
  worktrees: {
    cleanup: "keep",
    copyFiles: [],
    setupCommands: [],
    rerunSetupOnReuse: false,
  },
  run: {
    defaultWorkers: 2,
    defaultUntil: "blocked",
    defaultMaxCycles: 12,
    pollIntervalMs: 2_000,
  },
  landing: {
    policy: "auto",
    validateCommands: ["npm run lint", "npm run test", "npm run typecheck"],
    commandTimeoutMs: 600_000,
    maxRebaseAttempts: 2,
    review: {
      enabled: false,
      provider: undefined,
      model: undefined,
      commandTimeoutMs: 180_000,
      maxRemediationAttempts: 1,
      maxContextChars: 12_000,
    },
  },
  supervisor: {
    pollIntervalMs: 30_000,
  },
};
