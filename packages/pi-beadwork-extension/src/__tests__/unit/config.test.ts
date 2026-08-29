import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertGoalModeConfig,
  collectRejectedSupervisorKeys,
  loadConfig,
  REJECTED_SUPERVISOR_ENV_VARS,
  SupervisorConfigError,
} from "../../config.js";
import { DEFAULT_CONFIG } from "../../constants.js";

afterEach(() => {
  delete process.env.PI_BEADWORK_REVIEW_MAX_ARTIFACT_CHARS;
  delete process.env.PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS;
  delete process.env.PI_BEADWORK_WORKER_EXECUTION_MODE;
  delete process.env.PI_BEADWORK_WORKER_MAX_LIFETIME;
  delete process.env.PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD;
  delete process.env.PI_BEADWORK_WORKER_REVIEW_ENABLED;
  delete process.env.PI_BEADWORK_WORKER_SELF_REVIEW_ENABLED;
});

async function writeProjectConfig(repoRoot: string, config: unknown): Promise<void> {
  await mkdir(path.join(repoRoot, ".pi"), { recursive: true });
  await writeFile(
    path.join(repoRoot, ".pi", "beadwork-config.json"),
    JSON.stringify(config),
    "utf8",
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

describe("retained goal-mode config", () => {
  it("defaults to display/prompt settings only", () => {
    expect(DEFAULT_CONFIG).toEqual({
      ui: { showInactiveStatus: false },
      storage: { sessionStateDir: ".pi/beadwork/session-state" },
      review: { policy: "ticket", provider: undefined, model: undefined },
    });
    expect(DEFAULT_CONFIG).not.toHaveProperty("tmux");
    expect(DEFAULT_CONFIG).not.toHaveProperty("landing");
    expect(DEFAULT_CONFIG).not.toHaveProperty("workerExecution");
    expect(DEFAULT_CONFIG).not.toHaveProperty("worktrees");
    expect(DEFAULT_CONFIG).not.toHaveProperty("supervisor");
  });

  it("does not merge supervisor leftovers into loaded config", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-home-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));
    await writeProjectConfig(repoRoot, {
      landing: { review: { maxArtifactChars: 3456, enabled: true } },
      workerExecution: { mode: "worktree" },
      tmux: { sessionName: "pi-bw" },
    });

    const config = loadConfig(repoRoot, {
      homeDir,
      env: {
        PI_BEADWORK_REVIEW_ENABLED: "true",
        PI_BEADWORK_WORKER_EXECUTION_MODE: "current-branch",
        PI_BEADWORK_REVIEW_PROVIDER: "openai",
        PI_BEADWORK_REVIEW_MODEL: "gpt-5.4",
      },
    });

    expect(config).not.toHaveProperty("landing");
    expect(config).not.toHaveProperty("workerExecution");
    expect(config).not.toHaveProperty("tmux");
    expect(config.review.provider).toBe("openai");
    expect(config.review.model).toBe("gpt-5.4");
  });
});

describe("goal-mode supervisor config rejection", () => {
  it.each([
    ["tmux.sessionName", { tmux: { sessionName: "pi-bw" } }, "tmux.sessionName"],
    ["tmux.workerCommand", { tmux: { workerCommand: "pi" } }, "tmux.workerCommand"],
    ["worktrees.baseDir", { worktrees: { baseDir: "/tmp/worktrees" } }, "worktrees.baseDir"],
    ["worktrees.cleanup", { worktrees: { cleanup: "keep" } }, "worktrees.cleanup"],
    [
      "landing.validateCommands",
      { landing: { validateCommands: ["npm test"] } },
      "landing.validateCommands",
    ],
    ["landing.policy", { landing: { policy: "auto" } }, "landing.policy"],
    [
      "landing.review.enabled",
      { landing: { review: { enabled: true } } },
      "landing.review.enabled",
    ],
    [
      "supervisor.pollIntervalMs",
      { supervisor: { pollIntervalMs: 1000 } },
      "supervisor.pollIntervalMs",
    ],
    [
      "workerExecution.mode",
      { workerExecution: { mode: "current-branch" } },
      "workerExecution.mode",
    ],
    ["run.defaultWorkers", { run: { defaultWorkers: 4 } }, "run.defaultWorkers"],
    ["run.defaultUntil", { run: { defaultUntil: "blocked" } }, "run.defaultUntil"],
    ["run.defaultMaxCycles", { run: { defaultMaxCycles: 3 } }, "run.defaultMaxCycles"],
    ["run.pollIntervalMs", { run: { pollIntervalMs: 500 } }, "run.pollIntervalMs"],
    [
      "storage.workerRegistryFile",
      { storage: { workerRegistryFile: "registry.json" } },
      "storage.workerRegistryFile",
    ],
    ["storage.runtimeDir", { storage: { runtimeDir: "runtime" } }, "storage.runtimeDir"],
  ] as const)("rejects JSON %s", (_name, config, key) => {
    expect(collectRejectedSupervisorKeys({ configs: [config] })).toEqual([key]);
  });

  it.each([...REJECTED_SUPERVISOR_ENV_VARS])("rejects env %s", (envVar) => {
    expect(collectRejectedSupervisorKeys({ env: { [envVar]: "1" } })).toEqual([envVar]);
  });

  it("aggregates every leftover JSON family and env var into one error", () => {
    const rejected = collectRejectedSupervisorKeys({
      configs: [
        {
          tmux: { sessionName: "pi-bw" },
          worktrees: { baseDir: "/tmp/wt" },
          landing: { validateCommands: ["npm test"], review: { enabled: true } },
          supervisor: { pollIntervalMs: 5 },
          workerExecution: { mode: "worktree" },
          run: {
            defaultWorkers: 2,
            defaultUntil: "empty",
            defaultMaxCycles: 1,
            pollIntervalMs: 10,
          },
          storage: {
            workerRegistryFile: "registry.json",
            runtimeDir: "runtime",
          },
        },
      ],
      env: Object.fromEntries(REJECTED_SUPERVISOR_ENV_VARS.map((key) => [key, "1"])),
    });

    expect(rejected).toEqual(
      uniqueSorted([
        "landing.review.enabled",
        "landing.validateCommands",
        "run.defaultMaxCycles",
        "run.defaultUntil",
        "run.defaultWorkers",
        "run.pollIntervalMs",
        "storage.runtimeDir",
        "storage.workerRegistryFile",
        "supervisor.pollIntervalMs",
        "tmux.sessionName",
        "workerExecution.mode",
        "worktrees.baseDir",
        ...REJECTED_SUPERVISOR_ENV_VARS,
      ]),
    );

    const error = new SupervisorConfigError(rejected);
    expect(error.message).toContain("tmux.sessionName");
    expect(error.message).toContain("landing.validateCommands");
    expect(error.message).toContain("PI_BEADWORK_DEFAULT_WORKERS");
    expect(error.message).toContain("standing appendix plus injected prompt");
    for (const key of rejected) {
      expect(error.message).toContain(`- ${key}`);
    }
  });

  it("fails goal-mode start when tmux.sessionName is configured", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-home-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-goal-"));
    await writeProjectConfig(repoRoot, { tmux: { sessionName: "pi-bw" } });

    expect(() => assertGoalModeConfig(repoRoot, { homeDir, env: {} })).toThrow(
      SupervisorConfigError,
    );
    expect(() => assertGoalModeConfig(repoRoot, { homeDir, env: {} })).toThrow(/tmux\.sessionName/);
  });

  it("loads a clean config for goal mode", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-home-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-goal-"));
    await writeProjectConfig(repoRoot, {
      ui: { showInactiveStatus: true },
      storage: { sessionStateDir: ".pi/cache/session-state" },
      review: { policy: "scope", provider: "openai", model: "gpt-5.4" },
    });

    const config = assertGoalModeConfig(repoRoot, { homeDir, env: {} });
    expect(config.ui.showInactiveStatus).toBe(true);
    expect(config.storage.sessionStateDir).toBe(".pi/cache/session-state");
    expect(config.review).toEqual({
      policy: "scope",
      provider: "openai",
      model: "gpt-5.4",
    });
  });

  it("retains display/prompt review settings and does not map landing.review onto a runner", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-home-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-goal-"));
    await writeProjectConfig(repoRoot, {
      review: { policy: "ticket", provider: "anthropic", model: "claude" },
      landing: { review: { enabled: true, provider: "openai", model: "gpt" } },
    });

    const rejected = collectRejectedSupervisorKeys({
      configs: [
        {
          review: { policy: "ticket", provider: "anthropic", model: "claude" },
          landing: { review: { enabled: true, provider: "openai", model: "gpt" } },
        },
      ],
    });
    expect(rejected).toEqual([
      "landing.review.enabled",
      "landing.review.model",
      "landing.review.provider",
    ]);

    const loaded = loadConfig(repoRoot, { homeDir, env: {} });
    expect(loaded.review.policy).toBe("ticket");
    expect(loaded.review.provider).toBe("anthropic");
    expect(loaded.review.model).toBe("claude");
    expect(loaded).not.toHaveProperty("landing");
  });

  it("retains ui.showInactiveStatus and storage.sessionStateDir from env", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-home-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-goal-"));

    const config = assertGoalModeConfig(repoRoot, {
      homeDir,
      env: {
        PI_BEADWORK_SHOW_INACTIVE_STATUS: "true",
        PI_BEADWORK_SESSION_STATE_DIR: "/tmp/session-state",
        PI_BEADWORK_REVIEW_POLICY: "none",
        PI_BEADWORK_REVIEW_PROVIDER: "openai",
        PI_BEADWORK_REVIEW_MODEL: "gpt-5.4",
      },
    });

    expect(config.ui.showInactiveStatus).toBe(true);
    expect(config.storage.sessionStateDir).toBe("/tmp/session-state");
    expect(config.review).toEqual({
      policy: "none",
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(config).not.toHaveProperty("landing");
  });

  it("fails goal-mode start for landing-review gate env leftovers and logs the keys", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-home-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-goal-"));
    const env = {
      PI_BEADWORK_REVIEW_ENABLED: "true",
      PI_BEADWORK_REVIEW_TIMEOUT_MS: "1000",
      PI_BEADWORK_REVIEW_MAX_REMEDIATION_ATTEMPTS: "4",
      PI_BEADWORK_REVIEW_MAX_ARTIFACT_CHARS: "6789",
      PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS: "5678",
    };

    expect(() => assertGoalModeConfig(repoRoot, { homeDir, env })).toThrow(SupervisorConfigError);
    try {
      assertGoalModeConfig(repoRoot, { homeDir, env });
      expect.unreachable("expected SupervisorConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(SupervisorConfigError);
      const rejected = (error as SupervisorConfigError).rejectedKeys;
      expect(rejected).toEqual(uniqueSorted(Object.keys(env)));
      for (const key of rejected) {
        expect((error as SupervisorConfigError).message).toContain(`- ${key}`);
      }
    }
  });

  it("does not reject display/prompt review env vars", () => {
    expect(REJECTED_SUPERVISOR_ENV_VARS).not.toContain("PI_BEADWORK_REVIEW_POLICY");
    expect(REJECTED_SUPERVISOR_ENV_VARS).not.toContain("PI_BEADWORK_REVIEW_PROVIDER");
    expect(REJECTED_SUPERVISOR_ENV_VARS).not.toContain("PI_BEADWORK_REVIEW_MODEL");
    expect(REJECTED_SUPERVISOR_ENV_VARS).not.toContain("PI_BEADWORK_SHOW_INACTIVE_STATUS");
    expect(REJECTED_SUPERVISOR_ENV_VARS).not.toContain("PI_BEADWORK_SESSION_STATE_DIR");
  });
});
