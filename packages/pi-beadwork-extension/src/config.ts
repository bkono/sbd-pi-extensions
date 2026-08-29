import { accessSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "./constants.js";
import type { BeadworkConfig, ReviewPolicy } from "./types.js";

type PartialGoalReviewConfig = {
  policy?: unknown;
  provider?: unknown;
  model?: unknown;
};

type PartialConfig = {
  ui?: Partial<BeadworkConfig["ui"]>;
  storage?: Partial<BeadworkConfig["storage"]>;
  review?: PartialGoalReviewConfig;
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

function readJsonConfig(filePath: string): unknown | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
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
    },
    review: {
      policy: normalizeReviewPolicy(override.review?.policy, "review.policy") ?? base.review.policy,
      provider: normalizeOptionalString(override.review?.provider) ?? base.review.provider,
      model: normalizeOptionalString(override.review?.model) ?? base.review.model,
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
  const reviewPolicy = env.PI_BEADWORK_REVIEW_POLICY;
  const reviewProvider = env.PI_BEADWORK_REVIEW_PROVIDER;
  const reviewModel = env.PI_BEADWORK_REVIEW_MODEL;

  return {
    ui: {
      showInactiveStatus:
        showInactiveStatus !== undefined
          ? showInactiveStatus === "1" || showInactiveStatus.toLowerCase() === "true"
          : undefined,
    },
    storage: {
      sessionStateDir,
    },
    review: {
      policy: reviewPolicy,
      provider: reviewProvider,
      model: reviewModel,
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

function asPartialConfig(document: unknown): PartialConfig {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return {};
  }

  const record = document as Record<string, unknown>;
  return {
    ui: record.ui as PartialConfig["ui"],
    storage: record.storage as PartialConfig["storage"],
    review: record.review as PartialConfig["review"],
  };
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
    config = mergeConfig(config, asPartialConfig(document));
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
