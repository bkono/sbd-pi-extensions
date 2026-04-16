import { accessSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "./constants.js";
import type { BeadworkConfig, LandingPolicy, WorktreeCopyRule } from "./types.js";

type PartialConfig = {
  ui?: Partial<BeadworkConfig["ui"]>;
  storage?: Partial<BeadworkConfig["storage"]>;
  tmux?: Partial<BeadworkConfig["tmux"]>;
  worktrees?: Partial<BeadworkConfig["worktrees"]>;
  run?: Partial<BeadworkConfig["run"]>;
  landing?: Partial<Omit<BeadworkConfig["landing"], "review">> & {
    review?: Partial<BeadworkConfig["landing"]["review"]>;
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

function mergeConfig(base: BeadworkConfig, override?: PartialConfig): BeadworkConfig {
  if (!override) {
    return base;
  }

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
        maxContextChars:
          override.landing?.review?.maxContextChars ?? base.landing.review.maxContextChars,
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
  const reviewMaxContextChars = process.env.PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS;
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
        maxContextChars: reviewMaxContextChars
          ? Number.parseInt(reviewMaxContextChars, 10)
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
