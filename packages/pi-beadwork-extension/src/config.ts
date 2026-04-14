import { accessSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "./constants.js";
import type { BeadworkConfig } from "./types.js";

type PartialConfig = {
  ui?: Partial<BeadworkConfig["ui"]>;
  storage?: Partial<BeadworkConfig["storage"]>;
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

  config = mergeConfig(config, {
    ui: {
      showInactiveStatus:
        showInactiveStatus !== undefined
          ? showInactiveStatus === "1" || showInactiveStatus.toLowerCase() === "true"
          : undefined,
    },
    storage: {
      sessionStateDir,
    },
  });

  return config;
}
