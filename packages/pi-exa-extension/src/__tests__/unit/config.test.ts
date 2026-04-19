import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let currentFakeHome = "";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => currentFakeHome,
  };
});

const { loadConfig } = await import("../../config.js");

describe("loadConfig", () => {
  let fakeCwd: string;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "PI_EXA_API_KEY",
    "EXA_API_KEY",
    "PI_EXA_DEFAULT_SEARCH_TYPE",
    "PI_EXA_SEARCH_TYPE",
    "PI_EXA_DEFAULT_NUM_RESULTS",
    "PI_EXA_NUM_RESULTS",
    "PI_EXA_MAX_TEXT_PER_RESULT",
  ];

  beforeEach(() => {
    currentFakeHome = mkdtempSync(join(tmpdir(), "exa-home-"));
    fakeCwd = mkdtempSync(join(tmpdir(), "exa-cwd-"));
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(currentFakeHome, { recursive: true, force: true });
    rmSync(fakeCwd, { recursive: true, force: true });
  });

  function writeConfig(dir: string, config: unknown) {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "exa-config.json"), JSON.stringify(config));
  }

  it("returns defaults when no config files or env vars exist", () => {
    const config = loadConfig(fakeCwd);
    expect(config.apiKey).toBeUndefined();
    expect(config.defaultSearchType).toBe("auto");
    expect(config.defaultNumResults).toBe(5);
    expect(config.maxTextPerResult).toBe(800);
  });

  it("global config overrides defaults", () => {
    writeConfig(currentFakeHome, {
      apiKey: "exa-global",
      defaultSearchType: "keyword",
      defaultNumResults: 7,
      maxTextPerResult: 1200,
    });

    const config = loadConfig(fakeCwd);
    expect(config.apiKey).toBe("exa-global");
    expect(config.defaultSearchType).toBe("keyword");
    expect(config.defaultNumResults).toBe(7);
    expect(config.maxTextPerResult).toBe(1200);
  });

  it("project config overrides global config", () => {
    writeConfig(currentFakeHome, {
      apiKey: "exa-global",
      defaultSearchType: "keyword",
      defaultNumResults: 7,
    });
    writeConfig(fakeCwd, {
      apiKey: "exa-project",
      defaultSearchType: "neural",
      defaultNumResults: 3,
    });

    const config = loadConfig(fakeCwd);
    expect(config.apiKey).toBe("exa-project");
    expect(config.defaultSearchType).toBe("neural");
    expect(config.defaultNumResults).toBe(3);
  });

  it("env vars override project config", () => {
    writeConfig(fakeCwd, {
      apiKey: "exa-project",
      defaultSearchType: "keyword",
      defaultNumResults: 3,
      maxTextPerResult: 500,
    });
    process.env.PI_EXA_API_KEY = "exa-env";
    process.env.PI_EXA_DEFAULT_SEARCH_TYPE = "auto";
    process.env.PI_EXA_DEFAULT_NUM_RESULTS = "9";
    process.env.PI_EXA_MAX_TEXT_PER_RESULT = "1500";

    const config = loadConfig(fakeCwd);
    expect(config.apiKey).toBe("exa-env");
    expect(config.defaultSearchType).toBe("auto");
    expect(config.defaultNumResults).toBe(9);
    expect(config.maxTextPerResult).toBe(1500);
  });

  it("supports compatibility aliases in config and environment", () => {
    writeConfig(fakeCwd, {
      exaApiKey: "exa-file",
      searchType: "keyword",
      numResults: 4,
    });
    process.env.EXA_API_KEY = "exa-env-alias";

    const config = loadConfig(fakeCwd);
    expect(config.apiKey).toBe("exa-env-alias");
    expect(config.defaultSearchType).toBe("keyword");
    expect(config.defaultNumResults).toBe(4);
  });

  it("clamps configured result counts to the supported range", () => {
    writeConfig(fakeCwd, {
      defaultNumResults: 999,
    });

    const config = loadConfig(fakeCwd);
    expect(config.defaultNumResults).toBe(10);
  });

  it("warns to stderr when config file has invalid JSON", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const configDir = join(currentFakeHome, ".pi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "exa-config.json"), "{ invalid json ,,,");

    const config = loadConfig(fakeCwd);

    expect(config.defaultSearchType).toBe("auto");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[exa:config] Failed to parse config file"),
    );
    spy.mockRestore();
  });
});
