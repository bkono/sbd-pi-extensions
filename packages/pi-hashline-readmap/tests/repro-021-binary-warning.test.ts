/**
 * Reproduction test for Bug #021:
 * read and grep silently treat binary files as UTF-8 with no warning.
 */

import { unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packagePath = (filePath: string) => fileURLToPath(new URL(`../${filePath}`, import.meta.url));
const BINARY_FILE = packagePath("tests/fixtures/binary-test.bin");
const PLAIN_TEXT_FILE = packagePath("tests/fixtures/plain.txt");
const BINARY_CONTENT = Buffer.concat([
  Buffer.from("PNG\x00\x00\x00\rIHDR"),
  Buffer.from("\x00\xff\xfe\xfd".repeat(20)),
  Buffer.from("text content"),
  Buffer.from("\x00\x01\x02\x03".repeat(5)),
]);

async function getReadTool() {
  const { registerReadTool } = await import("../src/read.js");
  let captured: any = null;
  const mockPi = {
    registerTool(def: any) {
      captured = def;
    },
  };
  registerReadTool(mockPi as any);
  if (!captured) throw new Error("read tool was not registered");
  return captured;
}

async function getGrepTool() {
  const { registerGrepTool } = await import("../src/grep.js");
  let captured: any = null;
  const mockPi = {
    registerTool(def: any) {
      captured = def;
    },
  };
  registerGrepTool(mockPi as any);
  if (!captured) throw new Error("grep tool was not registered");
  return captured;
}

function text(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}

describe("Bug #021: binary files read/grepped without warning", () => {
  beforeAll(async () => {
    await writeFile(BINARY_FILE, BINARY_CONTENT);
  });

  afterAll(async () => {
    await unlink(BINARY_FILE).catch(() => {});
  });

  it("FAILS: read on binary file shows no warning — garbled output returned silently", async () => {
    const tool = await getReadTool();

    const result = await tool.execute(
      "tc",
      { path: BINARY_FILE },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(result.details.ptcValue.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "binary-content" })]),
    );
    expect(result.isError).toBeFalsy();
  });

  it("grep on binary file should warn or skip matches", async () => {
    const tool = await getGrepTool();

    const result = await tool.execute(
      "tc",
      { pattern: ".", path: BINARY_FILE },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    expect(result.details.ptcValue).toMatchObject({ totalMatches: 0, records: [] });
    expect(result.isError).toBeFalsy();
  });

  it("non-binary text files are unaffected", async () => {
    const readTool = await getReadTool();
    const readResult = await readTool.execute(
      "tc",
      { path: PLAIN_TEXT_FILE },
      new AbortController().signal,
      () => {},
      { cwd: process.cwd() },
    );

    const readOutput = text(readResult);
    expect(readResult.details.ptcValue.warnings).toEqual([]);
    expect(readOutput).toMatch(/^1:[0-9a-f]{3}\|/m);
  });
});
