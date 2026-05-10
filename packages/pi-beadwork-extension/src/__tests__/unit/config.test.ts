import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";
import { DEFAULT_CONFIG } from "../../constants.js";

afterEach(() => {
  delete process.env.PI_BEADWORK_REVIEW_MAX_ARTIFACT_CHARS;
  delete process.env.PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS;
  delete process.env.PI_BEADWORK_WORKER_EXECUTION_MODE;
  delete process.env.PI_BEADWORK_WORKER_MAX_LIFETIME;
  delete process.env.PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD;
  delete process.env.PI_BEADWORK_WORKER_REVIEW_ENABLED;
});

async function writeProjectConfig(repoRoot: string, config: unknown): Promise<void> {
  await mkdir(path.join(repoRoot, ".pi"), { recursive: true });
  await writeFile(
    path.join(repoRoot, ".pi", "beadwork-config.json"),
    JSON.stringify(config),
    "utf8",
  );
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

  it("prefers the new env var but still accepts the legacy alias", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pi-bw-config-"));

    process.env.PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS = "5678";
    expect(loadConfig(repoRoot).landing.review.maxArtifactChars).toBe(5678);

    process.env.PI_BEADWORK_REVIEW_MAX_ARTIFACT_CHARS = "6789";
    expect(loadConfig(repoRoot).landing.review.maxArtifactChars).toBe(6789);
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
      },
    });

    process.env.PI_BEADWORK_WORKER_EXECUTION_MODE = "current-branch";
    process.env.PI_BEADWORK_WORKER_MAX_LIFETIME = "200";
    process.env.PI_BEADWORK_WORKER_ALLOW_DETACHED_HEAD = "1";
    process.env.PI_BEADWORK_WORKER_REVIEW_ENABLED = "false";

    const config = loadConfig(repoRoot);
    expect(config.workerExecution.mode).toBe("current-branch");
    expect(config.workerExecution.maxLifetime).toBe(200);
    expect(config.workerExecution.allowDetachedHead).toBe(true);
    expect(config.workerExecution.review.enabled).toBe(false);
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
  });
});
