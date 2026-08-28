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

describe("reviewer config", () => {
  it("defaults to a 30 minute reviewer timeout and bounded artifact budget", () => {
    expect(DEFAULT_CONFIG.landing.review.commandTimeoutMs).toBe(1_800_000);
    expect(DEFAULT_CONFIG.landing.review.maxArtifactChars).toBe(12_000);
  });

  it("reads maxArtifactChars from project config", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));
    await mkdir(path.join(repoRoot, ".pi"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".pi", "beadwork-config.json"),
      JSON.stringify({
        landing: {
          review: {
            maxArtifactChars: 3456,
          },
        },
      }),
      "utf8",
    );

    const config = loadConfig(repoRoot);
    expect(config.landing.review.maxArtifactChars).toBe(3456);
  });

  it("accepts legacy maxContextChars project config as a compatibility alias", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));
    await mkdir(path.join(repoRoot, ".pi"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".pi", "beadwork-config.json"),
      JSON.stringify({
        landing: {
          review: {
            maxContextChars: 4567,
          },
        },
      }),
      "utf8",
    );

    const config = loadConfig(repoRoot);
    expect(config.landing.review.maxArtifactChars).toBe(4567);
  });

  it("does not map landing-review gate env leftovers into landing.review", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "pi-bw-home-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));

    const config = loadConfig(repoRoot, {
      homeDir,
      env: {
        PI_BEADWORK_REVIEW_ENABLED: "true",
        PI_BEADWORK_REVIEW_TIMEOUT_MS: "1000",
        PI_BEADWORK_REVIEW_MAX_REMEDIATION_ATTEMPTS: "4",
        PI_BEADWORK_REVIEW_MAX_ARTIFACT_CHARS: "6789",
        PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS: "5678",
        PI_BEADWORK_REVIEW_PROVIDER: "openai",
        PI_BEADWORK_REVIEW_MODEL: "gpt-5.4",
      },
    });

    expect(config.landing.review).toEqual(DEFAULT_CONFIG.landing.review);
    expect(config.review.provider).toBe("openai");
    expect(config.review.model).toBe("gpt-5.4");
  });
});

describe("worker execution config", () => {
  it("loads defaults independently from landing review", () => {
    expect(DEFAULT_CONFIG.workerExecution).toEqual({
      mode: "current-branch",
      maxLifetime: null,
      allowDetachedHead: false,
      review: {
        enabled: true,
      },
      selfReview: {
        enabled: true,
      },
    });
    expect(DEFAULT_CONFIG.landing.review.enabled).toBe(false);
  });

  it("reads workerExecution from project config", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));
    await writeProjectConfig(repoRoot, {
      workerExecution: {
        mode: "current-branch",
        maxLifetime: 300_000,
        allowDetachedHead: true,
        review: {
          enabled: false,
        },
        selfReview: {
          enabled: false,
        },
      },
    });

    const config = loadConfig(repoRoot);
    expect(config.workerExecution).toEqual({
      mode: "current-branch",
      maxLifetime: 300_000,
      allowDetachedHead: true,
      review: {
        enabled: false,
      },
      selfReview: {
        enabled: false,
      },
    });
  });

  it("preserves explicit worktree workerExecution from project config", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));
    await writeProjectConfig(repoRoot, {
      workerExecution: {
        mode: "worktree",
      },
    });

    expect(loadConfig(repoRoot).workerExecution.mode).toBe("worktree");
  });

  it("lets env override project workerExecution config", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));
    await writeProjectConfig(repoRoot, {
      workerExecution: {
        mode: "worktree",
        maxLifetime: 100,
        allowDetachedHead: false,
        review: {
          enabled: true,
        },
        selfReview: {
          enabled: false,
        },
      },
    });

    process.env.PI_BEADWORK_WORKER_EXECUTION_MODE = "current-branch";
    process.env.PI_BEADWORK_WORKER_MAX_LIFETIME = "200";
    process.env.PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD = "1";
    process.env.PI_BEADWORK_WORKER_REVIEW_ENABLED = "false";
    process.env.PI_BEADWORK_WORKER_SELF_REVIEW_ENABLED = "true";

    const config = loadConfig(repoRoot);
    expect(config.workerExecution.mode).toBe("current-branch");
    expect(config.workerExecution.maxLifetime).toBe(200);
    expect(config.workerExecution.allowDetachedHead).toBe(true);
    expect(config.workerExecution.review.enabled).toBe(false);
    expect(config.workerExecution.selfReview.enabled).toBe(true);
  });

  it("lets env force worktree over current-branch config", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));
    await writeProjectConfig(repoRoot, {
      workerExecution: {
        mode: "current-branch",
      },
    });

    process.env.PI_BEADWORK_WORKER_EXECUTION_MODE = "worktree";

    expect(loadConfig(repoRoot).workerExecution.mode).toBe("worktree");
  });

  it("parses maxLifetime null, empty, unset, and numeric values", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));
    expect(loadConfig(repoRoot).workerExecution.maxLifetime).toBeNull();

    await writeProjectConfig(repoRoot, {
      workerExecution: {
        maxLifetime: 500,
      },
    });
    expect(loadConfig(repoRoot).workerExecution.maxLifetime).toBe(500);

    process.env.PI_BEADWORK_WORKER_MAX_LIFETIME = "";
    expect(loadConfig(repoRoot).workerExecution.maxLifetime).toBeNull();

    process.env.PI_BEADWORK_WORKER_MAX_LIFETIME = "750";
    expect(loadConfig(repoRoot).workerExecution.maxLifetime).toBe(750);
  });

  it("keeps workerExecution review independent from landing review", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));
    await writeProjectConfig(repoRoot, {
      landing: {
        review: {
          enabled: false,
        },
      },
      workerExecution: {
        review: {
          enabled: true,
        },
      },
    });

    const config = loadConfig(repoRoot);
    expect(config.landing.review.enabled).toBe(false);
    expect(config.workerExecution.review.enabled).toBe(true);

    process.env.PI_BEADWORK_WORKER_REVIEW_ENABLED = "0";
    expect(loadConfig(repoRoot).workerExecution.review.enabled).toBe(false);
    expect(loadConfig(repoRoot).landing.review.enabled).toBe(false);
    process.env.PI_BEADWORK_WORKER_SELF_REVIEW_ENABLED = "0";
    expect(loadConfig(repoRoot).workerExecution.selfReview.enabled).toBe(false);
  });

  it("does not use worktree settings to resolve current-branch execution", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));
    await writeProjectConfig(repoRoot, {
      workerExecution: {
        mode: "current-branch",
      },
      worktrees: {
        cleanup: "cleanup-after-landing",
        copyFiles: [".env"],
        setupCommands: ["npm install"],
        rerunSetupOnReuse: true,
      },
    });

    const config = loadConfig(repoRoot);
    expect(config.workerExecution.mode).toBe("current-branch");
    expect(config.workerExecution.allowDetachedHead).toBe(false);
    expect(config.workerExecution.review.enabled).toBe(true);
  });

  it("throws clear errors for invalid workerExecution values", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));

    process.env.PI_BEADWORK_WORKER_EXECUTION_MODE = "branch";
    expect(() => loadConfig(repoRoot)).toThrow(/workerExecution\.mode.*current-branch.*worktree/);
    delete process.env.PI_BEADWORK_WORKER_EXECUTION_MODE;

    process.env.PI_BEADWORK_WORKER_MAX_LIFETIME = "soon";
    expect(() => loadConfig(repoRoot)).toThrow(/workerExecution\.maxLifetime.*non-negative/);
    delete process.env.PI_BEADWORK_WORKER_MAX_LIFETIME;

    process.env.PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD = "maybe";
    expect(() => loadConfig(repoRoot)).toThrow(/workerExecution\.allowDetachedHead.*boolean/);
    delete process.env.PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD;

    process.env.PI_BEADWORK_WORKER_REVIEW_ENABLED = "maybe";
    expect(() => loadConfig(repoRoot)).toThrow(/workerExecution\.review\.enabled.*boolean/);
    delete process.env.PI_BEADWORK_WORKER_REVIEW_ENABLED;

    process.env.PI_BEADWORK_WORKER_SELF_REVIEW_ENABLED = "maybe";
    expect(() => loadConfig(repoRoot)).toThrow(/workerExecution\.selfReview\.enabled.*boolean/);
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
    expect(loaded.landing.review.enabled).toBe(true);
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
    expect(config.landing.review.provider).toBeUndefined();
    expect(config.landing.review.model).toBeUndefined();
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
