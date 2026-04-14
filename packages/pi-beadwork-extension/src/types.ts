export type ActivationKind = "inactive" | "available" | "active";

export type ActivationReason =
  | "no-git"
  | "no-bw"
  | "cwd-unavailable"
  | "repo-not-initialized"
  | "repo-not-configured"
  | "error";

export type ActivationState = {
  kind: ActivationKind;
  reason?: ActivationReason;
  repoRoot?: string;
  detail?: string;
};

export type SessionMode = "neutral" | "interactive" | "run";

export type SessionScope =
  | { kind: "none" }
  | { kind: "ticket"; id: string }
  | { kind: "epic"; id: string };

export type SessionState = {
  mode: SessionMode;
  scope: SessionScope;
  updatedAt: string;
};

export type BeadworkConfig = {
  ui: {
    showInactiveStatus: boolean;
  };
  storage: {
    sessionStateDir: string;
  };
};
