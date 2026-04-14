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
  },
};
