import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureHashInit } from "../src/hashline.js";
import { getOrGenerateMap } from "../src/map-cache.js";
import * as readModule from "../src/read.js";
import * as readOutputModule from "../src/read-output.js";
import { formatFileMapWithBudget } from "../src/readmap/formatter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

async function callReadTool(params: {
  path: string;
  offset?: number;
  limit?: number;
  symbol?: string;
  map?: boolean;
}) {
  let capturedTool: any = null;
  const mockPi = {
    registerTool(def: any) {
      capturedTool = def;
    },
  };
  readModule.registerReadTool(mockPi as any);
  if (!capturedTool) throw new Error("read tool was not registered");
  return capturedTool.execute("test-call", params, new AbortController().signal, () => {}, {
    cwd: process.cwd(),
  });
}

function getTextContent(result: any): string {
  return result.content.find((c: any) => c.type === "text")?.text ?? "";
}

function makeBareCrFixture(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "pi-read-output-warning-"));
  const filePath = resolve(dir, "bare-cr.txt");
  writeFileSync(filePath, "alpha\rbeta\rgamma", "utf-8");
  return filePath;
}

describe("buildReadOutput metadata", () => {
  beforeAll(async () => {
    await ensureHashInit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("projects explicit map requests through the shared read builder", async () => {
    const filePath = resolve(fixturesDir, "small.ts");
    const selectedLines = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n").split("\n");
    const fileMap = await getOrGenerateMap(filePath);
    if (!fileMap) throw new Error("expected map for small.ts");
    const mapText = formatFileMapWithBudget(fileMap);
    const spy = vi.spyOn(readOutputModule, "buildReadOutput");

    const result = await callReadTool({ path: filePath, map: true });

    const lastInput = spy.mock.calls.at(-1)?.[0];
    const built = spy.mock.results.at(-1)?.value;
    expect(typeof lastInput?.map?.text).toBe("string");
    expect(
      lastInput?.map && { requested: lastInput.map.requested, appended: lastInput.map.appended },
    ).toEqual({
      requested: true,
      appended: true,
    });
    expect(lastInput?.map?.text).toBe(mapText);
    expect(getTextContent(result)).toBe(built.text);
    expect(result.details?.ptcValue).toEqual(built.ptcValue);
    expect(lastInput?.selectedLines).toEqual(selectedLines);
  });

  it("projects symbol reads through the shared read builder", async () => {
    const filePath = resolve(fixturesDir, "small.ts");
    const selectedLines = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n").split("\n");
    const spy = vi.spyOn(readOutputModule, "buildReadOutput");

    const result = await callReadTool({ path: filePath, symbol: "createDemoDirectory" });

    const lastInput = spy.mock.calls.at(-1)?.[0];
    const built = spy.mock.results.at(-1)?.value;
    expect(lastInput?.symbol).toEqual({
      query: "createDemoDirectory",
      name: "createDemoDirectory",
      kind: "function",
      parentName: undefined,
      startLine: 45,
      endLine: 49,
    });
    expect(lastInput?.selectedLines).toEqual(selectedLines.slice(44, 49));
    expect(
      built.text.startsWith("[Symbol: createDemoDirectory (function), lines 45-49 of 50]"),
    ).toBe(true);
    expect(getTextContent(result)).toBe(built.text);
    expect(result.details?.ptcValue).toEqual(built.ptcValue);
  });

  it("projects truncation metadata through the shared read builder", async () => {
    const filePath = resolve(fixturesDir, "large.ts");
    const spy = vi.spyOn(readOutputModule, "buildReadOutput");

    const result = await callReadTool({ path: filePath });

    const lastInput = spy.mock.calls.at(-1)?.[0];
    const built = spy.mock.results.at(-1)?.value;
    expect(lastInput?.truncation).toEqual({
      outputLines: result.details.truncation.outputLines,
      totalLines: result.details.truncation.totalLines,
      outputBytes: result.details.truncation.outputBytes,
      totalBytes: result.details.truncation.totalBytes,
    });
    expect(built.ptcValue.truncation).not.toBeNull();
    expect(getTextContent(result)).toBe(built.text);
    expect(result.details?.ptcValue).toEqual(built.ptcValue);
  });

  it("projects structured warnings through the shared read builder", async () => {
    const filePath = makeBareCrFixture();
    const spy = vi.spyOn(readOutputModule, "buildReadOutput");

    const result = await callReadTool({ path: filePath });

    const lastInput = spy.mock.calls.at(-1)?.[0];
    const built = spy.mock.results.at(-1)?.value;
    expect(lastInput?.warnings).toMatchObject([{ code: "bare-cr" }]);
    expect(built.text).toContain(lastInput?.warnings?.[0].message);
    expect(getTextContent(result)).toBe(built.text);
    expect(result.details?.ptcValue).toEqual(built.ptcValue);
  });
});
