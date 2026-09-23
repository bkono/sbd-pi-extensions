import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { registerGrepTool } from "../src/grep.js";
import { ensureHashInit } from "../src/hashline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

async function getGrepTool() {
  let capturedTool: any = null;
  registerGrepTool({
    registerTool(def: any) {
      capturedTool = def;
    },
  } as any);
  if (!capturedTool) throw new Error("grep tool was not registered");
  return capturedTool;
}

async function callGrepTool(params: Record<string, unknown>) {
  const tool = await getGrepTool();
  return tool.execute("test-call", params, new AbortController().signal, () => {}, {
    cwd: process.cwd(),
  });
}

function getTextContent(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}

function writeFixture(name: string, content: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), "pi-grep-scope-context-"));
  const filePath = resolve(dir, name);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("grep scopeContext parameter", () => {
  beforeAll(async () => {
    await ensureHashInit();
  });

  it("rejects non-numeric scopeContext string with a coercion error", async () => {
    const filePath = resolve(fixturesDir, "small.ts");
    const result = await callGrepTool({
      pattern: "createDemoDirectory",
      path: filePath,
      literal: true,
      scope: "symbol",
      scopeContext: "not-a-number",
    });
    expect(result.isError).toBe(true);
    expect(result.details.ptcValue.error.code).toBe("invalid-params-combo");
  });

  it("rejects negative scopeContext with a non-negative-integer error", async () => {
    const filePath = resolve(fixturesDir, "small.ts");
    const result = await callGrepTool({
      pattern: "createDemoDirectory",
      path: filePath,
      literal: true,
      scope: "symbol",
      scopeContext: -1,
    });
    expect(result.isError).toBe(true);
    expect(result.details.ptcValue.error.code).toBe("invalid-params-combo");
  });

  it("rejects scopeContext when scope is not 'symbol' and points to 'context'", async () => {
    const filePath = resolve(fixturesDir, "small.ts");
    const result = await callGrepTool({
      pattern: "createDemoDirectory",
      path: filePath,
      literal: true,
      scopeContext: 3,
      // no scope: "symbol"
    });
    expect(result.isError).toBe(true);
    expect(result.details.ptcValue.error.code).toBe("invalid-params-combo");
  });

  it("renders symbol header with '±0 lines' suffix and only match lines when scopeContext is 0", async () => {
    const filePath = writeFixture(
      "win0.ts",
      [
        "export function alpha() {",
        "  const a = 1;",
        "  console.log(target);",
        "  const c = 3;",
        "  return target;",
        "}",
      ].join("\n"),
    );

    const result = await callGrepTool({
      pattern: "target",
      path: filePath,
      literal: true,
      scope: "symbol",
      scopeContext: 0,
    });
    const text = getTextContent(result);
    const displayPath = basename(filePath);

    expect(text).toContain(
      `--- ${displayPath} :: function alpha (1-6, 2 matches, scoped to ±0 lines) ---`,
    );
    expect(text).toMatch(/:>>3:[0-9a-f]+\|/);
    expect(text).toMatch(/:>>5:[0-9a-f]+\|/);
    expect(text).not.toMatch(/: {2}1:/);
    expect(text).not.toMatch(/: {2}2:/);
    expect(text).not.toMatch(/: {2}4:/);
    expect(text).not.toMatch(/: {2}6:/);
  });

  it("emits no extra warning line when the window clips at symbol boundary", async () => {
    const filePath = writeFixture(
      "clip.ts",
      [
        "export function alpha() {",
        "  const target = 1;",
        "  const a = 2;",
        "  const b = 3;",
        "  const c = 4;",
        "  const d = 5;",
        "  return 0;",
        "}",
      ].join("\n"),
    );

    const result = await callGrepTool({
      pattern: "target",
      path: filePath,
      literal: true,
      scope: "symbol",
      scopeContext: 5,
    });
    expect(result.details.ptcValue.scopes.warnings).toEqual([]);
  });

  it("renders ±N context lines around match with the header suffix (end-to-end)", async () => {
    const filePath = writeFixture(
      "winN.ts",
      [
        "export function alpha() {",
        "  const a = 1;",
        "  const b = 2;",
        "  const c = 3;",
        "  const target = 4;",
        "  const e = 5;",
        "  const f = 6;",
        "  const g = 7;",
        "  return 0;",
        "}",
      ].join("\n"),
    );

    const result = await callGrepTool({
      pattern: "target",
      path: filePath,
      literal: true,
      scope: "symbol",
      scopeContext: 2,
    });
    const text = getTextContent(result);
    const displayPath = basename(filePath);

    expect(text).toContain(
      `--- ${displayPath} :: function alpha (1-10, 1 matches, scoped to ±2 lines) ---`,
    );
    expect(text).toMatch(/: {2}3:[0-9a-f]+\|/);
    expect(text).toMatch(/: {2}4:[0-9a-f]+\|/);
    expect(text).toMatch(/:>>5:[0-9a-f]+\|/);
    expect(text).toMatch(/: {2}6:[0-9a-f]+\|/);
    expect(text).toMatch(/: {2}7:[0-9a-f]+\|/);
    expect(text).not.toMatch(/: {2}1:/);
    expect(text).not.toMatch(/: {2}2:/);
    expect(text).not.toMatch(/: {2}8:/);
    expect(text).not.toMatch(/: {2}9:/);
    expect(text).not.toMatch(/: {2}10:/);
  });

  it("falls back unchanged when a file is unmappable; scopeContext has no effect", async () => {
    const filePath = resolve(fixturesDir, "plain.txt");
    const withCtx = await callGrepTool({
      pattern: "plain text",
      path: filePath,
      literal: true,
      scope: "symbol",
      scopeContext: 3,
    });
    const withoutCtx = await callGrepTool({
      pattern: "plain text",
      path: filePath,
      literal: true,
      scope: "symbol",
    });
    const textWithCtx = getTextContent(withCtx);
    const textWithoutCtx = getTextContent(withoutCtx);

    expect(withCtx.details.ptcValue.scopes).toMatchObject({
      groups: [],
      warnings: [{ code: "unmappable-file", path: filePath }],
    });
    const normal = await callGrepTool({ pattern: "plain text", path: filePath, literal: true });
    expect(withCtx.details.ptcValue.records).toEqual(normal.details.ptcValue.records);
    expect(textWithCtx).toBe(textWithoutCtx);
  });

  it("falls back unchanged for matches with no enclosing symbol; scopeContext has no effect", async () => {
    const filePath = writeFixture(
      "no-symbol.ts",
      ["// lonely marker", "export function alpha() {", "  return 1;", "}"].join("\n"),
    );

    const withCtx = await callGrepTool({
      pattern: "lonely",
      path: filePath,
      literal: true,
      context: 1,
      scope: "symbol",
      scopeContext: 3,
    });
    const withoutCtx = await callGrepTool({
      pattern: "lonely",
      path: filePath,
      literal: true,
      context: 1,
      scope: "symbol",
    });
    const textWithCtx = getTextContent(withCtx);
    const textWithoutCtx = getTextContent(withoutCtx);

    expect(withCtx.details.ptcValue.scopes).toMatchObject({
      groups: [],
      warnings: [{ code: "no-enclosing-symbol", path: filePath, line: 1 }],
    });
    const normal = await callGrepTool({
      pattern: "lonely",
      path: filePath,
      literal: true,
      context: 1,
    });
    expect(withCtx.details.ptcValue.records).toEqual(normal.details.ptcValue.records);
    expect(textWithCtx).toBe(textWithoutCtx);
  });

  it("summary: true silently ignores scopeContext", async () => {
    const filePath = resolve(fixturesDir, "small.ts");
    const summary = await callGrepTool({
      pattern: "export",
      path: filePath,
      literal: true,
      summary: true,
      scope: "symbol",
      scopeContext: 3,
    });
    const baseline = await callGrepTool({
      pattern: "export",
      path: filePath,
      literal: true,
      summary: true,
    });

    expect(summary.isError).toBeUndefined();
    expect(getTextContent(summary)).toBe(getTextContent(baseline));
    expect((summary.details?.ptcValue as any).scopes).toBeUndefined();
  });

  it("omitting scopeContext returns byte-identical full-body output (back-compat)", async () => {
    const filePath = resolve(fixturesDir, "small.ts");
    const full = await callGrepTool({
      pattern: "createDemoDirectory",
      path: filePath,
      literal: true,
      scope: "symbol",
    });

    expect((full.details?.ptcValue as any).scopes.groups[0].symbol).toBeDefined();
    expect((full.details?.ptcValue as any).scopes.groups[0].contextLines).toBeUndefined();
  });
});
