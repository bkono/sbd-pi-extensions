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

export type ReviewPolicy = "ticket" | "scope" | "none";

export type Goal = {
  goalId: string;
  /** V1 requires exactly one epic id. */
  scopeIds: string[];
  reviewPolicy: ReviewPolicy;
  startedAt: string;
};

export function isV1Goal(goal: Goal): boolean {
  return goal.scopeIds.length === 1 && Boolean(goal.scopeIds[0]);
}

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
  goal?: Goal;
  /** Disk rehydration of mode=run. Stays set across in-memory writes until a later /bw run. */
  runInterrupted?: boolean;
};

export type BeadworkConfig = {
  ui: {
    showInactiveStatus: boolean;
  };
  storage: {
    sessionStateDir: string;
  };
  review: {
    policy: ReviewPolicy;
    provider?: string;
    model?: string;
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

export type BeadworkUpdateIssueInput = {
  title?: string;
  description?: string;
  priority?: number;
  assignee?: string;
  type?: string;
  status?: string;
  parentId?: string | null;
  deferUntil?: string;
  dueAt?: string | null;
};

export type BeadworkCreateIssueResult = {
  issue: BeadworkIssue;
};

export type BeadworkHistoryEntry = {
  hash?: string;
  timestamp?: string;
  author?: string;
  intent?: string;
  [key: string]: unknown;
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

export type AdoptionPlanSourceKind = "inline" | "file" | "editor";

export type AdoptionPlanSource = {
  kind: AdoptionPlanSourceKind;
  markdown: string;
  label: string;
  path?: string;
};

export type AdoptionPlan = {
  source: string;
  sourceKind: AdoptionPlanSourceKind;
  sourceLabel: string;
  sourcePath?: string;
  title: string;
  landMode: AdoptionLandMode;
  steps: AdoptionStep[];
  dependencies: AdoptionDependency[];
  dependencyStrategy: "none" | "explicit";
};

export type AdoptionInputStep = {
  title: string;
  description?: string;
};

export type AdoptionOptions = {
  title?: string;
  landMode?: AdoptionLandMode;
  steps?: AdoptionInputStep[];
  dependencies?: AdoptionDependency[];
};

export type AdoptionApplyResult = {
  mode: AdoptionLandMode;
  root?: BeadworkIssue;
  created: BeadworkIssue[];
};
