import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetHashlineSettingsPathsForTest,
  __setHashlineSettingsPathsForTest,
} from "../src/hashline-settings.js";
import {
  BASH_CONTEXT_GUARD_DEFAULT_HEAD_LINES,
  BASH_CONTEXT_GUARD_DEFAULT_MAX_BYTES,
  BASH_CONTEXT_GUARD_DEFAULT_MAX_LINES,
  BASH_CONTEXT_GUARD_DEFAULT_TAIL_LINES,
  resolveBashContextGuardConfig,
} from "../src/rtk/bash-context-guard.js";

describe("resolveBashContextGuardConfig", () => {
  const saved = {
    enabled: process.env.PI_HASHLINE_BASH_CONTEXT_GUARD,
    maxLines: process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES,
    maxBytes: process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_BYTES,
    headLines: process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_HEAD_LINES,
    tailLines: process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_TAIL_LINES,
  };

  beforeEach(() => {
    delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD;
    delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES;
    delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_BYTES;
    delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_HEAD_LINES;
    delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_TAIL_LINES;
    __setHashlineSettingsPathsForTest({
      globalSettingsPath: join(tmpdir(), `missing-global-${randomBytes(6).toString("hex")}.json`),
      projectSettingsPath: join(tmpdir(), `missing-project-${randomBytes(6).toString("hex")}.json`),
    });
  });

  afterEach(() => {
    if (saved.enabled === undefined) delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD;
    else process.env.PI_HASHLINE_BASH_CONTEXT_GUARD = saved.enabled;
    if (saved.maxLines === undefined) delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES;
    else process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES = saved.maxLines;
    if (saved.maxBytes === undefined) delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_BYTES;
    else process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_BYTES = saved.maxBytes;
    if (saved.headLines === undefined) delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_HEAD_LINES;
    else process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_HEAD_LINES = saved.headLines;
    if (saved.tailLines === undefined) delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_TAIL_LINES;
    else process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_TAIL_LINES = saved.tailLines;
    __resetHashlineSettingsPathsForTest();
  });

  it("uses conservative defaults when env vars are unset", () => {
    expect(resolveBashContextGuardConfig()).toEqual({
      enabled: true,
      maxLines: 2000,
      maxBytes: 51200,
      headLines: 80,
      tailLines: 120,
    });
    expect(BASH_CONTEXT_GUARD_DEFAULT_MAX_LINES).toBe(2000);
    expect(BASH_CONTEXT_GUARD_DEFAULT_MAX_BYTES).toBe(51200);
    expect(BASH_CONTEXT_GUARD_DEFAULT_HEAD_LINES).toBe(80);
    expect(BASH_CONTEXT_GUARD_DEFAULT_TAIL_LINES).toBe(120);
  });

  it("uses JSON Bash context guard config when env is unset", async () => {
    const root = join(tmpdir(), `bash-json-${randomBytes(6).toString("hex")}`);
    const projectSettingsPath = join(root, "repo/.pi/hashline-readmap/settings.json");
    await mkdir(join(projectSettingsPath, ".."), { recursive: true });
    await writeFile(
      projectSettingsPath,
      JSON.stringify({
        bashContextGuard: {
          enabled: false,
          maxLines: 25,
          maxBytes: 1024,
          headLines: 3,
          tailLines: 7,
        },
      }),
    );
    __setHashlineSettingsPathsForTest({
      globalSettingsPath: join(root, "missing.json"),
      projectSettingsPath,
    });
    try {
      expect(resolveBashContextGuardConfig()).toEqual({
        enabled: false,
        maxLines: 25,
        maxBytes: 1024,
        headLines: 3,
        tailLines: 7,
      });
    } finally {
      __resetHashlineSettingsPathsForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets nonzero Bash guard env override JSON disabled", async () => {
    const root = join(tmpdir(), `bash-env-${randomBytes(6).toString("hex")}`);
    const projectSettingsPath = join(root, "repo/.pi/hashline-readmap/settings.json");
    await mkdir(join(projectSettingsPath, ".."), { recursive: true });
    await writeFile(projectSettingsPath, JSON.stringify({ bashContextGuard: { enabled: false } }));
    __setHashlineSettingsPathsForTest({
      globalSettingsPath: join(root, "missing.json"),
      projectSettingsPath,
    });
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD = "false";
    try {
      expect(resolveBashContextGuardConfig().enabled).toBe(true);
    } finally {
      delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD;
      __resetHashlineSettingsPathsForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls through to JSON Bash guard budget when env values are invalid", async () => {
    const root = join(tmpdir(), `bash-invalid-env-json-${randomBytes(6).toString("hex")}`);
    const projectSettingsPath = join(root, "repo/.pi/hashline-readmap/settings.json");
    await mkdir(join(projectSettingsPath, ".."), { recursive: true });
    await writeFile(
      projectSettingsPath,
      JSON.stringify({
        bashContextGuard: { maxLines: 25, maxBytes: 1024, headLines: 3, tailLines: 7 },
      }),
    );
    __setHashlineSettingsPathsForTest({
      globalSettingsPath: join(root, "missing.json"),
      projectSettingsPath,
    });
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES = "abc";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_BYTES = "1e3";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_HEAD_LINES = "0";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_TAIL_LINES = "3.14";
    try {
      expect(resolveBashContextGuardConfig()).toEqual({
        enabled: true,
        maxLines: 25,
        maxBytes: 1024,
        headLines: 3,
        tailLines: 7,
      });
    } finally {
      delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES;
      delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_BYTES;
      delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_HEAD_LINES;
      delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_TAIL_LINES;
      __resetHashlineSettingsPathsForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses valid below-default positive base-10 env values", () => {
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES = "25";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_BYTES = "1024";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_HEAD_LINES = "3";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_TAIL_LINES = "7";

    expect(resolveBashContextGuardConfig()).toEqual({
      enabled: true,
      maxLines: 25,
      maxBytes: 1024,
      headLines: 3,
      tailLines: 7,
    });
  });

  it("keeps existing env-only Bash guard budget behavior", () => {
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES = "25";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_BYTES = "1024";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_HEAD_LINES = "3";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_TAIL_LINES = "7";
    try {
      expect(resolveBashContextGuardConfig()).toEqual({
        enabled: true,
        maxLines: 25,
        maxBytes: 1024,
        headLines: 3,
        tailLines: 7,
      });
    } finally {
      delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES;
      delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_BYTES;
      delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_HEAD_LINES;
      delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_TAIL_LINES;
    }
  });

  it("trims surrounding whitespace before parsing env values", () => {
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES = " 25 ";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_BYTES = "\t1024\n";

    expect(resolveBashContextGuardConfig().maxLines).toBe(25);
    expect(resolveBashContextGuardConfig().maxBytes).toBe(1024);
  });

  it("falls back to defaults for invalid env values", () => {
    for (const raw of ["abc", "", " ", "0", "-1", "+1", "3.14", "0x10", "1e3", "1,000", "1_000"]) {
      process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES = raw;
      process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_BYTES = raw;
      process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_HEAD_LINES = raw;
      process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_TAIL_LINES = raw;

      expect(resolveBashContextGuardConfig()).toEqual({
        enabled: true,
        maxLines: 2000,
        maxBytes: 51200,
        headLines: 80,
        tailLines: 120,
      });
    }
  });

  it("clamps above-default env values to defaults", () => {
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES = "99999";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_BYTES = "104857600";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_HEAD_LINES = "999";
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_TAIL_LINES = "999";

    expect(resolveBashContextGuardConfig()).toEqual({
      enabled: true,
      maxLines: 2000,
      maxBytes: 51200,
      headLines: 80,
      tailLines: 120,
    });
  });

  it("clamps above-default JSON Bash guard budget fields", async () => {
    const root = join(tmpdir(), `bash-clamp-${randomBytes(6).toString("hex")}`);
    const projectSettingsPath = join(root, "repo/.pi/hashline-readmap/settings.json");
    await mkdir(join(projectSettingsPath, ".."), { recursive: true });
    await writeFile(
      projectSettingsPath,
      JSON.stringify({
        bashContextGuard: {
          maxLines: 99999,
          maxBytes: 999999999,
          headLines: 999,
          tailLines: 999,
        },
      }),
    );
    __setHashlineSettingsPathsForTest({
      globalSettingsPath: join(root, "missing.json"),
      projectSettingsPath,
    });
    try {
      expect(resolveBashContextGuardConfig()).toMatchObject({
        maxLines: BASH_CONTEXT_GUARD_DEFAULT_MAX_LINES,
        maxBytes: BASH_CONTEXT_GUARD_DEFAULT_MAX_BYTES,
        headLines: BASH_CONTEXT_GUARD_DEFAULT_HEAD_LINES,
        tailLines: BASH_CONTEXT_GUARD_DEFAULT_TAIL_LINES,
      });
    } finally {
      __resetHashlineSettingsPathsForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("disables the guard only when PI_HASHLINE_BASH_CONTEXT_GUARD is exactly 0", () => {
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD = "0";
    try {
      expect(resolveBashContextGuardConfig().enabled).toBe(false);
      process.env.PI_HASHLINE_BASH_CONTEXT_GUARD = "false";
      expect(resolveBashContextGuardConfig().enabled).toBe(true);
    } finally {
      delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD;
    }
  });

  it("re-reads env on every call", () => {
    expect(resolveBashContextGuardConfig().maxLines).toBe(2000);
    process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES = "9";
    expect(resolveBashContextGuardConfig().maxLines).toBe(9);
    delete process.env.PI_HASHLINE_BASH_CONTEXT_GUARD_MAX_LINES;
    expect(resolveBashContextGuardConfig().maxLines).toBe(2000);
  });
});
