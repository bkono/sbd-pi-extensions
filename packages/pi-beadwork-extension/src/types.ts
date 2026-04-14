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
  | { kind: "ticket"; id: string; title?: string }
  | { kind: "epic"; id: string; title?: string };

export type PrimeCache = {
  content: string;
  loadedAt: string;
  repoRoot?: string;
};

export type SessionState = {
  mode: SessionMode;
  scope: SessionScope;
  updatedAt: string;
  engagedAt?: string;
  prime?: PrimeCache;
};

export type BeadworkConfig = {
  ui: {
    showInactiveStatus: boolean;
  };
  storage: {
    sessionStateDir: string;
  };
};

export type BeadworkIssue = {
  id: string;
  title: string;
  description: string;
  status: string;
  type: string;
  priority: number;
  labels: string[];
  blockedBy: string[];
  blocks: string[];
  assignee: string;
  createdAt: string;
  updatedAt: string;
  parentId?: string;
};

export type BeadworkIssueDetail = BeadworkIssue & {
  children: BeadworkIssue[];
};

export type BeadworkCreateIssueInput = {
  title: string;
  description?: string;
  type?: string;
  priority?: number;
  parentId?: string;
};

export type BeadworkCreateIssueResult = {
  issue: BeadworkIssue;
};

export type BeadworkListFilters = {
  status?: string;
  type?: string;
  parent?: string;
  priority?: number;
  assignee?: string;
  grep?: string;
  limit?: number;
  all?: boolean;
  deferred?: boolean;
  overdue?: boolean;
};

export type BeadworkCounts = {
  ready: number;
  blocked: number;
  inProgress: number;
  scopedReady?: number;
};

export type AdoptionLandMode = "quick" | "branch" | "multi";

export type AdoptionStep = {
  index: number;
  title: string;
  description: string;
};

export type AdoptionDependency = {
  blockerIndex: number;
  blockedIndex: number;
};

export type AdoptionPlan = {
  source: string;
  title: string;
  landMode: AdoptionLandMode;
  steps: AdoptionStep[];
  dependencies: AdoptionDependency[];
  dependencyStrategy: "none" | "explicit" | "sequential";
};

export type AdoptionOptions = {
  title?: string;
  landMode?: AdoptionLandMode;
  sequential?: boolean;
};

export type AdoptionApplyResult = {
  mode: AdoptionLandMode;
  root?: BeadworkIssue;
  created: BeadworkIssue[];
};

export type ExtensionBranchEntryLike = {
  type: string;
  message?: {
    content?: unknown;
  };
};
