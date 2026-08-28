import { accessSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "./constants.js";
import type {
  BeadworkConfig,
  LandingPolicy,
  ReviewPolicy,
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

type PartialGoalReviewConfig = {
  policy?: unknown;
  provider?: unknown;
  model?: unknown;
};

type PartialConfig = {
  ui?: Partial<BeadworkConfig["ui"]>;
  storage?: Partial<BeadworkConfig["storage"]>;
  review?: PartialGoalReviewConfig;
  tmux?: Partial<BeadworkConfig["tmux"]>;
  worktrees?: Partial<BeadworkConfig["worktrees"]>;
  workerExecution?: PartialWorkerExecutionConfig;
  run?: Partial<BeadworkConfig["run"]>;
  landing?: Partial<Omit<BeadworkConfig["landing"], "review">> & {
    review?: PartialReviewConfig;
  };
  supervisor?: Partial<BeadworkConfig["supervisor"]>;
};

export type LoadConfigOptions = {
  env?: NodeJS.Dict<string | undefined>;
  homeDir?: string;
};

export type InspectedBeadworkConfig = {
  config: BeadworkConfig;
  rejectedKeys: string[];
};

const REJECTED_JSON_FAMILIES = [
  "tmux",
  "worktrees",
  "landing",
  "supervisor",
  "workerExecution",
] as const;

const REJECTED_RUN_KEYS = [
  "defaultWorkers",
  "defaultUntil",
  "defaultMaxCycles",
  "pollIntervalMs",
] as const;

const REJECTED_STORAGE_KEYS = ["workerRegistryFile", "runtimeDir"] as const;

export const REJECTED_SUPERVISOR_ENV_VARS = [
  "PI_BEADWORK_WORKER_REGISTRY_FILE",
  "PI_BEADWORK_RUNTIME_DIR",
  "PI_BEADWORK_TMUX_SESSION_NAME",
  "PI_BEADWORK_WORKER_COMMAND",
  "PI_BEADWORK_WORKER_PROVIDER",
  "PI_BEADWORK_WORKER_MODEL",
  "PI_BEADWORK_WORKTREE_BASE_DIR",
  "PI_BEADWORK_WORKER_EXECUTION_MODE",
  "PI_BEADWORK_WORKER_MAX_LIFETIME",
  "PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD",
  "PI_BEADWORK_WORKER_REVIEW_ENABLED",
  "PI_BEADWORK_WORKER_SELF_REVIEW_ENABLED",
  "PI_BEADWORK_DEFAULT_WORKERS",
  "PI_BEADWORK_DEFAULT_MAX_CYCLES",
  "PI_BEADWORK_POLL_INTERVAL_MS",
  "PI_BEADWORK_VALIDATE_TIMEOUT_MS",
  "PI_BEADWORK_MAX_REBASE_ATTEMPTS",
  "PI_BEADWORK_LANDING_POLICY",
  "PI_BEADWORK_REVIEW_ENABLED",
  "PI_BEADWORK_REVIEW_TIMEOUT_MS",
  "PI_BEADWORK_REVIEW_MAX_REMEDIATION_ATTEMPTS",
  "PI_BEADWORK_REVIEW_MAX_ARTIFACT_CHARS",
  "PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS",
  "PI_BEADWORK_SUPERVISOR_POLL_INTERVAL_MS",
] as const;

export class SupervisorConfigError extends Error {
  readonly rejectedKeys: string[];

  constructor(rejectedKeys: string[]) {
    const unique = uniqueSorted(rejectedKeys);
    super(formatSupervisorConfigError(unique));
    this.name = "SupervisorConfigError";
    this.rejectedKeys = unique;
  }
}

export function formatSupervisorConfigError(rejectedKeys: string[]): string {
  const listed = rejectedKeys.map((key) => `- ${key}`).join("\n");
  return [
    "Beadwork goal mode refuses supervisor config leftovers. Remove:",
    listed,
    "",
    "/bw run is a standing appendix plus injected prompt, not a polling supervisor.",
    "Do not migrate landing.validateCommands into a validation gate.",
  ].join("\n");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

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

function normalizeReviewPolicy(value: unknown, fieldName: string): ReviewPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "ticket" || value === "scope" || value === "none") {
    return value;
  }
  throw new Error(`${fieldName} must be "ticket", "scope", or "none"`);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
    review: {
      policy: normalizeReviewPolicy(override.review?.policy, "review.policy") ?? base.review.policy,
      provider: normalizeOptionalString(override.review?.provider) ?? base.review.provider,
      model: normalizeOptionalString(override.review?.model) ?? base.review.model,
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

function flattenPresentPaths(value: unknown, prefix: string): string[] {
  if (value === undefined) {
    return [prefix];
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return [prefix];
  }

  return entries.flatMap(([key, child]) => flattenPresentPaths(child, `${prefix}.${key}`));
}

function collectRejectedJsonKeys(config: unknown): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [];
  }

  const record = config as Record<string, unknown>;
  const keys: string[] = [];

  for (const family of REJECTED_JSON_FAMILIES) {
    if (family in record) {
      keys.push(...flattenPresentPaths(record[family], family));
    }
  }

  if (record.run && typeof record.run === "object" && !Array.isArray(record.run)) {
    const run = record.run as Record<string, unknown>;
    for (const key of REJECTED_RUN_KEYS) {
      if (key in run) {
        keys.push(`run.${key}`);
      }
    }
  }

  if (record.storage && typeof record.storage === "object" && !Array.isArray(record.storage)) {
    const storage = record.storage as Record<string, unknown>;
    for (const key of REJECTED_STORAGE_KEYS) {
      if (key in storage) {
        keys.push(`storage.${key}`);
      }
    }
  }

  return keys;
}

export function collectRejectedSupervisorKeys(input: {
  configs?: unknown[];
  env?: NodeJS.Dict<string | undefined>;
}): string[] {
  const keys: string[] = [];

  for (const config of input.configs ?? []) {
    keys.push(...collectRejectedJsonKeys(config));
  }

  if (input.env) {
    for (const envVar of REJECTED_SUPERVISOR_ENV_VARS) {
      if (input.env[envVar] !== undefined) {
        keys.push(envVar);
      }
    }
  }

  return uniqueSorted(keys);
}

function envPartialConfig(env: NodeJS.Dict<string | undefined>): PartialConfig {
  const showInactiveStatus = env.PI_BEADWORK_SHOW_INACTIVE_STATUS;
  const sessionStateDir = env.PI_BEADWORK_SESSION_STATE_DIR;
  const workerRegistryFile = env.PI_BEADWORK_WORKER_REGISTRY_FILE;
  const runtimeDir = env.PI_BEADWORK_RUNTIME_DIR;
  const tmuxSessionName = env.PI_BEADWORK_TMUX_SESSION_NAME;
  const workerCommand = env.PI_BEADWORK_WORKER_COMMAND;
  const workerProvider = env.PI_BEADWORK_WORKER_PROVIDER;
  const workerModel = env.PI_BEADWORK_WORKER_MODEL;
  const worktreeBaseDir = env.PI_BEADWORK_WORKTREE_BASE_DIR;
  const workerExecutionMode = env.PI_BEADWORK_WORKER_EXECUTION_MODE;
  const workerMaxLifetime = env.PI_BEADWORK_WORKER_MAX_LIFETIME;
  const workerAllowDetachedHead = env.PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD;
  const workerExecutionReviewEnabled = env.PI_BEADWORK_WORKER_REVIEW_ENABLED;
  const workerExecutionSelfReviewEnabled = env.PI_BEADWORK_WORKER_SELF_REVIEW_ENABLED;
  const defaultWorkers = env.PI_BEADWORK_DEFAULT_WORKERS;
  const defaultMaxCycles = env.PI_BEADWORK_DEFAULT_MAX_CYCLES;
  const pollIntervalMs = env.PI_BEADWORK_POLL_INTERVAL_MS;
  const validateTimeoutMs = env.PI_BEADWORK_VALIDATE_TIMEOUT_MS;
  const maxRebaseAttempts = env.PI_BEADWORK_MAX_REBASE_ATTEMPTS;
  const landingPolicy = env.PI_BEADWORK_LANDING_POLICY;
  const reviewPolicy = env.PI_BEADWORK_REVIEW_POLICY;
  const reviewProvider = env.PI_BEADWORK_REVIEW_PROVIDER;
  const reviewModel = env.PI_BEADWORK_REVIEW_MODEL;
  const supervisorPollIntervalMs = env.PI_BEADWORK_SUPERVISOR_POLL_INTERVAL_MS;

  return {
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
    review: {
      policy: reviewPolicy,
      provider: reviewProvider,
      model: reviewModel,
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
    },
    supervisor: {
      pollIntervalMs: supervisorPollIntervalMs
        ? Number.parseInt(supervisorPollIntervalMs, 10)
        : undefined,
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

function resolveGlobalConfigPath(homeDir: string): string {
  return path.join(homeDir, ".pi", "beadwork-config.json");
}

function readConfiguredDocuments(cwd: string, homeDir: string): unknown[] {
  const documents: unknown[] = [];
  const globalConfig = readJsonConfig(resolveGlobalConfigPath(homeDir));
  if (globalConfig) {
    documents.push(globalConfig);
  }

  const projectConfigPath = resolveProjectConfigPath(cwd);
  if (projectConfigPath) {
    const projectConfig = readJsonConfig(projectConfigPath);
    if (projectConfig) {
      documents.push(projectConfig);
    }
  }

  return documents;
}

export function inspectBeadworkConfig(
  cwd: string,
  options: LoadConfigOptions = {},
): InspectedBeadworkConfig {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const documents = readConfiguredDocuments(cwd, homeDir);

  let config = DEFAULT_CONFIG;
  for (const document of documents) {
    config = mergeConfig(config, document as PartialConfig);
  }
  config = mergeConfig(config, envPartialConfig(env));

  return {
    config,
    rejectedKeys: collectRejectedSupervisorKeys({ configs: documents, env }),
  };
}

export function loadConfig(cwd: string, options?: LoadConfigOptions): BeadworkConfig {
  return inspectBeadworkConfig(cwd, options).config;
}

export function assertGoalModeConfig(cwd: string, options?: LoadConfigOptions): BeadworkConfig {
  const { config, rejectedKeys } = inspectBeadworkConfig(cwd, options);
  if (rejectedKeys.length > 0) {
    throw new SupervisorConfigError(rejectedKeys);
  }
  return config;
}
