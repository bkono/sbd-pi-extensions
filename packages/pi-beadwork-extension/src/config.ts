import { accessSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "./constants.js";
import type {
  BeadworkConfig,
  LandingPolicy,
  WorkerExecutionMode,
  WorktreeCopyRule,
} from "./types.js";

type PartialReviewConfig = Partial<BeadworkConfig["landing"]["review"]> & {
  maxContextChars?: number;
};

type PartialWorkerExecutionConfig = {
  mode?: unknown;
  maxLifetime?: unknown;
  allowDetachedHead?: unknown;
  review?: {
    enabled?: unknown;
  };
  selfReview?: {
    enabled?: unknown;
  };
};

type PartialConfig = {
  ui?: Partial<BeadworkConfig["ui"]>;
  storage?: Partial<BeadworkConfig["storage"]>;
  tmux?: Partial<BeadworkConfig["tmux"]>;
  worktrees?: Partial<BeadworkConfig["worktrees"]>;
  workerExecution?: PartialWorkerExecutionConfig;
  run?: Partial<BeadworkConfig["run"]>;
  landing?: Partial<Omit<BeadworkConfig["landing"], "review">> & {
    review?: PartialReviewConfig;
  };
  supervisor?: Partial<BeadworkConfig["supervisor"]>;
};

function readJsonConfig(filePath: string): PartialConfig | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return parsed as PartialConfig;
  } catch {
    return undefined;
  }
}

function normalizeCopyRules(value: unknown): WorktreeCopyRule[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const rules: WorktreeCopyRule[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) {
      rules.push(entry);
      continue;
    }

    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { from?: unknown }).from === "string" &&
      (entry as { from: string }).from.length > 0
    ) {
      const objectEntry = entry as { from: string; to?: unknown; required?: unknown };
      rules.push({
        from: objectEntry.from,
        to:
          typeof objectEntry.to === "string" && objectEntry.to.length > 0
            ? objectEntry.to
            : undefined,
        required: typeof objectEntry.required === "boolean" ? objectEntry.required : undefined,
      });
    }
  }

  return rules;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function normalizeLandingPolicy(value: unknown): LandingPolicy | undefined {
  return value === "auto" || value === "deferred" ? value : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true") {
      return true;
    }
    if (normalized === "0" || normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function normalizeBooleanOrThrow(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = normalizeBoolean(value);
  if (normalized === undefined) {
    throw new Error(`${fieldName} must be a boolean (true/false or 1/0)`);
  }
  return normalized;
}

function normalizeWorkerExecutionMode(
  value: unknown,
  fieldName: string,
): WorkerExecutionMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "current-branch" || value === "worktree") {
    return value;
  }
  throw new Error(`${fieldName} must be "current-branch" or "worktree"`);
}

function normalizeMaxLifetime(value: unknown, fieldName: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative number of milliseconds or null`);
  }
  return parsed;
}

function resolveReviewMaxArtifactChars(review?: PartialReviewConfig): number | undefined {
  return review?.maxArtifactChars ?? review?.maxContextChars;
}

function mergeConfig(base: BeadworkConfig, override?: PartialConfig): BeadworkConfig {
  if (!override) {
    return base;
  }

  const workerExecutionMode = normalizeWorkerExecutionMode(
    override.workerExecution?.mode,
    "workerExecution.mode",
  );
  const workerMaxLifetime = normalizeMaxLifetime(
    override.workerExecution?.maxLifetime,
    "workerExecution.maxLifetime",
  );
  const workerAllowDetachedHead = normalizeBooleanOrThrow(
    override.workerExecution?.allowDetachedHead,
    "workerExecution.allowDetachedHead",
  );
  const workerReviewEnabled = normalizeBooleanOrThrow(
    override.workerExecution?.review?.enabled,
    "workerExecution.review.enabled",
  );
  const workerSelfReviewEnabled = normalizeBooleanOrThrow(
    override.workerExecution?.selfReview?.enabled,
    "workerExecution.selfReview.enabled",
  );

  return {
    ui: {
      showInactiveStatus: override.ui?.showInactiveStatus ?? base.ui.showInactiveStatus,
    },
    storage: {
      sessionStateDir: override.storage?.sessionStateDir ?? base.storage.sessionStateDir,
      workerRegistryFile: override.storage?.workerRegistryFile ?? base.storage.workerRegistryFile,
      runtimeDir: override.storage?.runtimeDir ?? base.storage.runtimeDir,
    },
    tmux: {
      sessionName: override.tmux?.sessionName ?? base.tmux.sessionName,
      workerCommand: override.tmux?.workerCommand ?? base.tmux.workerCommand,
      workerProvider: override.tmux?.workerProvider ?? base.tmux.workerProvider,
      workerModel: override.tmux?.workerModel ?? base.tmux.workerModel,
    },
    worktrees: {
      baseDir: override.worktrees?.baseDir ?? base.worktrees.baseDir,
      cleanup: override.worktrees?.cleanup ?? base.worktrees.cleanup,
      copyFiles: normalizeCopyRules(override.worktrees?.copyFiles) ?? base.worktrees.copyFiles,
      setupCommands:
        normalizeStringArray(override.worktrees?.setupCommands) ?? base.worktrees.setupCommands,
      rerunSetupOnReuse: override.worktrees?.rerunSetupOnReuse ?? base.worktrees.rerunSetupOnReuse,
    },
    workerExecution: {
      mode: workerExecutionMode ?? base.workerExecution.mode,
      maxLifetime:
        workerMaxLifetime !== undefined ? workerMaxLifetime : base.workerExecution.maxLifetime,
      allowDetachedHead: workerAllowDetachedHead ?? base.workerExecution.allowDetachedHead,
      review: {
        enabled: workerReviewEnabled ?? base.workerExecution.review.enabled,
      },
      selfReview: {
        enabled: workerSelfReviewEnabled ?? base.workerExecution.selfReview.enabled,
      },
    },
    run: {
      defaultWorkers: override.run?.defaultWorkers ?? base.run.defaultWorkers,
      defaultUntil: override.run?.defaultUntil ?? base.run.defaultUntil,
      defaultMaxCycles: override.run?.defaultMaxCycles ?? base.run.defaultMaxCycles,
      pollIntervalMs: override.run?.pollIntervalMs ?? base.run.pollIntervalMs,
    },
    landing: {
      policy: normalizeLandingPolicy(override.landing?.policy) ?? base.landing.policy,
      validateCommands:
        normalizeStringArray(override.landing?.validateCommands) ?? base.landing.validateCommands,
      commandTimeoutMs: override.landing?.commandTimeoutMs ?? base.landing.commandTimeoutMs,
      maxRebaseAttempts: override.landing?.maxRebaseAttempts ?? base.landing.maxRebaseAttempts,
      review: {
        enabled: normalizeBoolean(override.landing?.review?.enabled) ?? base.landing.review.enabled,
        provider: override.landing?.review?.provider ?? base.landing.review.provider,
        model: override.landing?.review?.model ?? base.landing.review.model,
        commandTimeoutMs:
          override.landing?.review?.commandTimeoutMs ?? base.landing.review.commandTimeoutMs,
        maxRemediationAttempts:
          override.landing?.review?.maxRemediationAttempts ??
          base.landing.review.maxRemediationAttempts,
        maxArtifactChars:
          resolveReviewMaxArtifactChars(override.landing?.review) ??
          base.landing.review.maxArtifactChars,
      },
    },
    supervisor: {
      pollIntervalMs: override.supervisor?.pollIntervalMs ?? base.supervisor.pollIntervalMs,
    },
  };
}

function canAccessDirectory(dirPath: string): boolean {
  try {
    accessSync(dirPath);
    return true;
  } catch {
    return false;
  }
}

function resolveProjectConfigPath(cwd: string): string | undefined {
  if (!canAccessDirectory(cwd)) {
    return undefined;
  }
  return path.join(cwd, ".pi", "beadwork-config.json");
}

function resolveGlobalConfigPath(): string {
  return path.join(os.homedir(), ".pi", "beadwork-config.json");
}

export function loadConfig(cwd: string): BeadworkConfig {
  let config = DEFAULT_CONFIG;

  const globalConfig = readJsonConfig(resolveGlobalConfigPath());
  config = mergeConfig(config, globalConfig);

  const projectConfigPath = resolveProjectConfigPath(cwd);
  if (projectConfigPath) {
    config = mergeConfig(config, readJsonConfig(projectConfigPath));
  }

  const showInactiveStatus = process.env.PI_BEADWORK_SHOW_INACTIVE_STATUS;
  const sessionStateDir = process.env.PI_BEADWORK_SESSION_STATE_DIR;
  const workerRegistryFile = process.env.PI_BEADWORK_WORKER_REGISTRY_FILE;
  const runtimeDir = process.env.PI_BEADWORK_RUNTIME_DIR;
  const tmuxSessionName = process.env.PI_BEADWORK_TMUX_SESSION_NAME;
  const workerCommand = process.env.PI_BEADWORK_WORKER_COMMAND;
  const workerProvider = process.env.PI_BEADWORK_WORKER_PROVIDER;
  const workerModel = process.env.PI_BEADWORK_WORKER_MODEL;
  const worktreeBaseDir = process.env.PI_BEADWORK_WORKTREE_BASE_DIR;
  const workerExecutionMode = process.env.PI_BEADWORK_WORKER_EXECUTION_MODE;
  const workerMaxLifetime = process.env.PI_BEADWORK_WORKER_MAX_LIFETIME;
  const workerAllowDetachedHead = process.env.PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD;
  const workerExecutionReviewEnabled = process.env.PI_BEADWORK_WORKER_REVIEW_ENABLED;
  const workerExecutionSelfReviewEnabled = process.env.PI_BEADWORK_WORKER_SELF_REVIEW_ENABLED;
  const defaultWorkers = process.env.PI_BEADWORK_DEFAULT_WORKERS;
  const defaultMaxCycles = process.env.PI_BEADWORK_DEFAULT_MAX_CYCLES;
  const pollIntervalMs = process.env.PI_BEADWORK_POLL_INTERVAL_MS;
  const validateTimeoutMs = process.env.PI_BEADWORK_VALIDATE_TIMEOUT_MS;
  const maxRebaseAttempts = process.env.PI_BEADWORK_MAX_REBASE_ATTEMPTS;
  const landingPolicy = process.env.PI_BEADWORK_LANDING_POLICY;
  const reviewEnabled = process.env.PI_BEADWORK_REVIEW_ENABLED;
  const reviewProvider = process.env.PI_BEADWORK_REVIEW_PROVIDER;
  const reviewModel = process.env.PI_BEADWORK_REVIEW_MODEL;
  const reviewTimeoutMs = process.env.PI_BEADWORK_REVIEW_TIMEOUT_MS;
  const reviewMaxRemediationAttempts = process.env.PI_BEADWORK_REVIEW_MAX_REMEDIATION_ATTEMPTS;
  const reviewMaxArtifactChars =
    process.env.PI_BEADWORK_REVIEW_MAX_ARTIFACT_CHARS ??
    process.env.PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS;
  const supervisorPollIntervalMs = process.env.PI_BEADWORK_SUPERVISOR_POLL_INTERVAL_MS;

  config = mergeConfig(config, {
    ui: {
      showInactiveStatus:
        showInactiveStatus !== undefined
          ? showInactiveStatus === "1" || showInactiveStatus.toLowerCase() === "true"
          : undefined,
    },
    storage: {
      sessionStateDir,
      workerRegistryFile,
      runtimeDir,
    },
    tmux: {
      sessionName: tmuxSessionName,
      workerCommand,
      workerProvider,
      workerModel,
    },
    worktrees: {
      baseDir: worktreeBaseDir,
    },
    workerExecution: {
      mode: workerExecutionMode,
      maxLifetime: workerMaxLifetime,
      allowDetachedHead: workerAllowDetachedHead,
      review: {
        enabled: workerExecutionReviewEnabled,
      },
      selfReview: {
        enabled: workerExecutionSelfReviewEnabled,
      },
    },
    run: {
      defaultWorkers: defaultWorkers ? Number.parseInt(defaultWorkers, 10) : undefined,
      defaultMaxCycles: defaultMaxCycles ? Number.parseInt(defaultMaxCycles, 10) : undefined,
      pollIntervalMs: pollIntervalMs ? Number.parseInt(pollIntervalMs, 10) : undefined,
    },
    landing: {
      policy: normalizeLandingPolicy(landingPolicy),
      commandTimeoutMs: validateTimeoutMs ? Number.parseInt(validateTimeoutMs, 10) : undefined,
      maxRebaseAttempts: maxRebaseAttempts ? Number.parseInt(maxRebaseAttempts, 10) : undefined,
      review: {
        enabled: normalizeBoolean(reviewEnabled),
        provider: reviewProvider,
        model: reviewModel,
        commandTimeoutMs: reviewTimeoutMs ? Number.parseInt(reviewTimeoutMs, 10) : undefined,
        maxRemediationAttempts: reviewMaxRemediationAttempts
          ? Number.parseInt(reviewMaxRemediationAttempts, 10)
          : undefined,
        maxArtifactChars: reviewMaxArtifactChars
          ? Number.parseInt(reviewMaxArtifactChars, 10)
          : undefined,
      },
    },
    supervisor: {
      pollIntervalMs: supervisorPollIntervalMs
        ? Number.parseInt(supervisorPollIntervalMs, 10)
        : undefined,
    },
  });

  return config;
}
