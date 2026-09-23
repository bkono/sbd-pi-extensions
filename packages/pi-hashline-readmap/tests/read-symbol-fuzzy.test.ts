import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMapCache } from "../src/map-cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

type ReadParams = {
  path: string;
  offset?: number;
  limit?: number;
  symbol?: string;
};

async function getReadTool() {
  const { registerReadTool } = await import("../src/read.js");
  let capturedTool: any = null;
  const mockPi = {
    registerTool(def: any) {
      capturedTool = def;
    },
  };
  registerReadTool(mockPi as any);
  if (!capturedTool) throw new Error("read tool was not registered");
  return capturedTool;
}

async function callReadTool(params: ReadParams) {
  const tool = await getReadTool();
  return tool.execute("test-call", params, new AbortController().signal, () => {}, {
    cwd: process.cwd(),
  });
}

function getTextContent(result: any): string {
  return result.content.find((c: any) => c.type === "text")?.text ?? "";
}

describe("read — fuzzy symbol match (issue 099)", () => {
  beforeEach(() => clearMapCache());
  afterEach(() => vi.restoreAllMocks());

  it("tier 4 substring: returns content AND prepends fuzzy banner AND emits fuzzy-symbol-match warning", async () => {
    const cacheModule = await import("../src/map-cache.js");
    const { DetailLevel, SymbolKind } = await import("../src/readmap/enums.js");

    vi.spyOn(cacheModule, "getOrGenerateMap").mockResolvedValue({
      path: resolve(fixturesDir, "small.ts"),
      totalLines: 100,
      totalBytes: 1000,
      language: "typescript",
      symbols: [
        { name: "initGetters", kind: SymbolKind.Function, startLine: 45, endLine: 49 },
        { name: "formatOutput", kind: SymbolKind.Function, startLine: 60, endLine: 70 },
      ],
      imports: [],
      detailLevel: DetailLevel.Full,
    });

    const result = await callReadTool({
      path: resolve(fixturesDir, "small.ts"),
      symbol: "get",
    });

    const text = getTextContent(result);

    expect(text).toContain("initGetters");
    expect(result.details.ptcValue.warnings[0].tier).toBe("substring");

    const warnings = (result.details as any)?.ptcValue?.warnings ?? [];
    expect(warnings.some((w: any) => w.code === "fuzzy-symbol-match")).toBe(true);
  });

  it("tier 3 camelCase: returns content AND prepends fuzzy banner with camelCase tier", async () => {
    const cacheModule = await import("../src/map-cache.js");
    const { DetailLevel, SymbolKind } = await import("../src/readmap/enums.js");

    vi.spyOn(cacheModule, "getOrGenerateMap").mockResolvedValue({
      path: resolve(fixturesDir, "small.ts"),
      totalLines: 100,
      totalBytes: 1000,
      language: "typescript",
      symbols: [
        { name: "getHandler", kind: SymbolKind.Function, startLine: 45, endLine: 49 },
        { name: "formatOutput", kind: SymbolKind.Function, startLine: 60, endLine: 70 },
      ],
      imports: [],
      detailLevel: DetailLevel.Full,
    });

    const result = await callReadTool({
      path: resolve(fixturesDir, "small.ts"),
      symbol: "handler",
    });

    const text = getTextContent(result);
    expect(text).toContain("getHandler");
    expect(result.details.ptcValue.warnings[0].tier).toBe("camelCase");

    const warnings = (result.details as any)?.ptcValue?.warnings ?? [];
    expect(warnings.some((w: any) => w.code === "fuzzy-symbol-match")).toBe(true);
  });

  it("tier 1 case-insensitive exact — no fuzzy banner (silent)", async () => {
    const cacheModule = await import("../src/map-cache.js");
    const { DetailLevel, SymbolKind } = await import("../src/readmap/enums.js");

    vi.spyOn(cacheModule, "getOrGenerateMap").mockResolvedValue({
      path: resolve(fixturesDir, "small.ts"),
      totalLines: 100,
      totalBytes: 1000,
      language: "typescript",
      symbols: [{ name: "ParseConfig", kind: SymbolKind.Function, startLine: 1, endLine: 2 }],
      imports: [],
      detailLevel: DetailLevel.Full,
    });

    const result = await callReadTool({
      path: resolve(fixturesDir, "small.ts"),
      symbol: "parseconfig",
    });

    const warnings = (result.details as any)?.ptcValue?.warnings ?? [];
    expect(warnings.some((w: any) => w.code === "fuzzy-symbol-match")).toBe(false);
  });

  it("fuzzy banner lists otherCandidates when cross-tier alternatives exist", async () => {
    const cacheModule = await import("../src/map-cache.js");
    const { DetailLevel, SymbolKind } = await import("../src/readmap/enums.js");

    vi.spyOn(cacheModule, "getOrGenerateMap").mockResolvedValue({
      path: resolve(fixturesDir, "small.ts"),
      totalLines: 100,
      totalBytes: 1000,
      language: "typescript",
      symbols: [
        { name: "getHandler", kind: SymbolKind.Function, startLine: 10, endLine: 20 },
        { name: "myhandlerthing", kind: SymbolKind.Function, startLine: 30, endLine: 35 },
        { name: "prehandlerX", kind: SymbolKind.Function, startLine: 40, endLine: 45 },
      ],
      imports: [],
      detailLevel: DetailLevel.Full,
    });

    const result = await callReadTool({
      path: resolve(fixturesDir, "small.ts"),
      symbol: "handler",
    });

    const text = getTextContent(result);
    expect(text).toContain("myhandlerthing");
    expect(text).toContain("prehandlerX");
    expect(text).toContain("getHandler@10");
    const warnings = (result.details as any)?.ptcValue?.warnings ?? [];
    const fuzzyWarning = warnings.find((w: any) => w.code === "fuzzy-symbol-match");
    expect(fuzzyWarning?.otherCandidates.map((candidate: any) => candidate.name)).toEqual([
      "myhandlerthing",
      "prehandlerX",
    ]);
  });

  it("fuzzy warning exposes machine-readable tier and otherCandidates", async () => {
    const cacheModule = await import("../src/map-cache.js");
    const { DetailLevel, SymbolKind } = await import("../src/readmap/enums.js");

    vi.spyOn(cacheModule, "getOrGenerateMap").mockResolvedValue({
      path: resolve(fixturesDir, "small.ts"),
      totalLines: 100,
      totalBytes: 1000,
      language: "typescript",
      symbols: [
        { name: "getHandler", kind: SymbolKind.Function, startLine: 10, endLine: 20 },
        { name: "myhandlerthing", kind: SymbolKind.Function, startLine: 30, endLine: 35 },
        { name: "prehandlerX", kind: SymbolKind.Function, startLine: 40, endLine: 45 },
      ],
      imports: [],
      detailLevel: DetailLevel.Full,
    });

    const result = await callReadTool({
      path: resolve(fixturesDir, "small.ts"),
      symbol: "handler",
    });

    const warnings = (result.details as any)?.ptcValue?.warnings ?? [];
    const fuzzyWarning = warnings.find((w: any) => w.code === "fuzzy-symbol-match");

    expect(fuzzyWarning).toMatchObject({
      code: "fuzzy-symbol-match",
      tier: "camelCase",
      otherCandidates: [
        { name: "myhandlerthing", kind: "function", startLine: 30, endLine: 35 },
        { name: "prehandlerX", kind: "function", startLine: 40, endLine: 45 },
      ],
    });
  });
});
