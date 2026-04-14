import { accessSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "./constants.js";
import type { BeadworkConfig } from "./types.js";

type PartialConfig = {
  ui?: Partial<BeadworkConfig["ui"]>;
  storage?: Partial<BeadworkConfig["storage"]>;
  tmux?: Partial<BeadworkConfig["tmux"]>;
  worktrees?: Partial<BeadworkConfig["worktrees"]>;
  run?: Partial<BeadworkConfig["run"]>;
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
    },
    worktrees: {
      baseDir: override.worktrees?.baseDir ?? base.worktrees.baseDir,
      cleanup: override.worktrees?.cleanup ?? base.worktrees.cleanup,
    },
    run: {
      defaultWorkers: override.run?.defaultWorkers ?? base.run.defaultWorkers,
      defaultUntil: override.run?.defaultUntil ?? base.run.defaultUntil,
      defaultMaxCycles: override.run?.defaultMaxCycles ?? base.run.defaultMaxCycles,
      pollIntervalMs: override.run?.pollIntervalMs ?? base.run.pollIntervalMs,
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
  const worktreeBaseDir = process.env.PI_BEADWORK_WORKTREE_BASE_DIR;
  const defaultWorkers = process.env.PI_BEADWORK_DEFAULT_WORKERS;
  const defaultMaxCycles = process.env.PI_BEADWORK_DEFAULT_MAX_CYCLES;
  const pollIntervalMs = process.env.PI_BEADWORK_POLL_INTERVAL_MS;

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
    },
    worktrees: {
      baseDir: worktreeBaseDir,
    },
    run: {
      defaultWorkers: defaultWorkers ? Number.parseInt(defaultWorkers, 10) : undefined,
      defaultMaxCycles: defaultMaxCycles ? Number.parseInt(defaultMaxCycles, 10) : undefined,
      pollIntervalMs: pollIntervalMs ? Number.parseInt(pollIntervalMs, 10) : undefined,
    },
  });

  return config;
}
