import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";
import { DEFAULT_CONFIG } from "../../constants.js";

afterEach(() => {
  delete process.env.PI_BEADWORK_REVIEW_MAX_ARTIFACT_CHARS;
  delete process.env.PI_BEADWORK_REVIEW_MAX_CONTEXT_CHARS;
});

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
