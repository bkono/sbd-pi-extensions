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

export type SessionRunOptions = {
  workers: number;
  until: RunUntil;
  noSpawn: boolean;
  dryRun: boolean;
};

export type SessionState = {
  mode: SessionMode;
  scope: SessionScope;
  updatedAt: string;
  engagedAt?: string;
  prime?: PrimeCache;
  trackedWorkerIds?: string[];
  workerNotices?: Record<string, string>;
  runOptions?: SessionRunOptions;
};

export type RunUntil = "blocked" | "empty";

export type LandingPolicy = "auto" | "deferred";

export type WorkerStatus =
  | "launching"
  | "running"
  | "exited"
  | "held"
  | "landed"
  | "failed"
  | "attention";

export type WorkerCleanupStatus = "pending" | "cleaned" | "failed";

export type WorkerValidationStatus = "pending" | "passed" | "failed";

export type WorkerRemediationStatus = "running" | "failed" | "exhausted";

export type WorkerReviewVerdict = "approve" | "approve-with-nits" | "request-changes";

export type WorkerReviewStatus =
  | "pending"
  | "approved"
  | "nits-only"
  | "changes-requested"
  | "remediation-in-progress"
  | "review-blocked";

export type WorktreeCopyRule =
  | string
  | {
      from: string;
      to?: string;
      required?: boolean;
    };

export type BeadworkConfig = {
  ui: {
    showInactiveStatus: boolean;
  };
  storage: {
    sessionStateDir: string;
    workerRegistryFile: string;
    runtimeDir: string;
  };
  tmux: {
    sessionName: string;
    workerCommand: string;
    workerProvider?: string;
    workerModel?: string;
  };
  worktrees: {
    baseDir?: string;
    cleanup: "keep" | "cleanup-after-landing";
    copyFiles: WorktreeCopyRule[];
    setupCommands: string[];
    rerunSetupOnReuse: boolean;
  };
  run: {
    defaultWorkers: number;
    defaultUntil: RunUntil;
    defaultMaxCycles: number;
    pollIntervalMs: number;
  };
  landing: {
    policy: LandingPolicy;
    validateCommands: string[];
    commandTimeoutMs: number;
    maxRebaseAttempts: number;
    review: {
      enabled: boolean;
      provider?: string;
      model?: string;
      commandTimeoutMs: number;
      maxRemediationAttempts: number;
      maxArtifactChars: number;
    };
  };
  supervisor: {
    pollIntervalMs: number;
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

export type WorkerRuntime = {
  workerId: string;
  ticketId: string;
  epicId?: string;
  ticketTitle: string;
  ticketStatus?: string;
  branchName: string;
  worktreePath: string;
  backend: "tmux";
  tmuxSession: string;
  tmuxWindow: string;
  tmuxPane: string;
  runtimeDir: string;
  promptFile: string;
  scriptFile: string;
  logFile: string;
  stateFile: string;
  exitCodeFile: string;
  finishedAtFile: string;
  launchCommand: string;
  workerCommand: string;
  workerProvider?: string;
  workerModel?: string;
  cleanupPolicy: BeadworkConfig["worktrees"]["cleanup"];
  landingPolicy?: LandingPolicy;
  landingHeldAt?: string;
  landingRequestedAt?: string;
  cleanupStatus?: WorkerCleanupStatus;
  cleanupAt?: string;
  validationStatus?: WorkerValidationStatus;
  validationAt?: string;
  validationSummary?: string;
  remediationStatus?: WorkerRemediationStatus;
  remediationAttempts?: number;
  remediationAt?: string;
  remediationSummary?: string;
  reviewerProvider?: string;
  reviewerModel?: string;
  reviewStatus?: WorkerReviewStatus;
  reviewVerdict?: WorkerReviewVerdict;
  reviewAt?: string;
  reviewSummary?: string;
  reviewFeedback?: string[];
  reviewValidFeedbackCount?: number;
  reviewInvalidFeedbackCount?: number;
  reviewRemediationAttempts?: number;
  reviewRemediationAt?: string;
  landingVerifiedAt?: string;
  landingVerification?: string;
  landingAheadCount?: number;
  landingBehindCount?: number;
  status: WorkerStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  lastError?: string;
};

export type WorkerSummary = {
  total: number;
  active: number;
  launching: number;
  running: number;
  exited: number;
  held: number;
  landed: number;
  failed: number;
  attention: number;
  cleaned: number;
};

export type RunOptions = {
  workers: number;
  until: RunUntil;
  dryRun: boolean;
  maxCycles: number;
  pollIntervalMs: number;
  noSpawn: boolean;
};

export type RunCycleSummary = {
  cycle: number;
  ready: string[];
  launched: string[];
  running: string[];
  held: string[];
  landed: string[];
  failed: string[];
  attention: string[];
  exited: string[];
};

export type RunSummary = {
  epicId: string;
  stopReason: "completed" | "blocked" | "empty" | "max-cycles" | "attention";
  cycles: number;
  launched: string[];
  activeWorkerIds: string[];
  workerSummary: WorkerSummary;
  notes: string[];
  cycleSummaries: RunCycleSummary[];
};
