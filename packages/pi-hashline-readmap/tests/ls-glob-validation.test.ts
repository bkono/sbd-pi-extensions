import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function getLsTool() {
  const { registerLsTool } = await import("../src/ls.js");
  let captured: any = null;
  registerLsTool({
    registerTool(def: any) {
      captured = def;
    },
  } as any);
  if (!captured) throw new Error("ls tool was not registered");
  return captured;
}

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), "ls-glob-"));
  writeFileSync(join(dir, "a.ts"), "");
  writeFileSync(join(dir, "b.ts"), "");
  return dir;
}

describe("ls glob validation", () => {
  it("rejects unterminated character class '[invalid' on a non-empty dir", async () => {
    const dir = makeDir();
    try {
      const tool = await getLsTool();
      const result = await tool.execute(
        "tc",
        { path: dir, glob: "[invalid" },
        new AbortController().signal,
        undefined,
        { cwd: process.cwd() },
      );
      expect(result.isError).toBe(true);
      expect(result.details?.ptcValue?.error?.code).toBe("invalid-params-combo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unterminated brace expansion '{unmatched'", async () => {
    const dir = makeDir();
    try {
      const tool = await getLsTool();
      const result = await tool.execute(
        "tc",
        { path: dir, glob: "{unmatched" },
        new AbortController().signal,
        undefined,
        { cwd: process.cwd() },
      );
      expect(result.isError).toBe(true);
      expect(result.details.ptcValue.error.code).toBe("invalid-params-combo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regression: valid glob '*.ts' still filters", async () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, "c.md"), "");
      const tool = await getLsTool();
      const result = await tool.execute(
        "tc",
        { path: dir, glob: "*.ts" },
        new AbortController().signal,
        undefined,
        { cwd: process.cwd() },
      );
      expect(result.isError).toBeFalsy();
      const entries = result.details?.ptcValue?.entries ?? [];
      expect(entries.map((e: any) => e.name).sort()).toEqual(["a.ts", "b.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regression: valid bracket glob '[ab].ts' matches a.ts and b.ts", async () => {
    const dir = makeDir();
    try {
      const tool = await getLsTool();
      const result = await tool.execute(
        "tc",
        { path: dir, glob: "[ab].ts" },
        new AbortController().signal,
        undefined,
        { cwd: process.cwd() },
      );
      expect(result.isError).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
