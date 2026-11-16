// tests/grep-symbol-scope-schema.test.ts

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registerGrepTool } from "../src/grep.js";

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

async function callGrepTool(params: {
  pattern: string;
  path: string;
  literal?: boolean;
  context?: number;
  summary?: boolean;
  scope?: "symbol";
}) {
  const tool = await getGrepTool();
  return tool.execute("test-call", params, new AbortController().signal, () => {}, {
    cwd: process.cwd(),
  });
}

function getTextContent(result: any): string {
  return result.content?.find((c: any) => c.type === "text")?.text ?? "";
}

describe("grep scope schema passthrough", () => {
  it("keeps scope off the model schema while execute() still honors it", async () => {
    const tool = await getGrepTool();
    expect(tool.parameters.properties.scope).toBeUndefined();

    const filePath = resolve(fixturesDir, "small.ts");

    const summaryBaseline = await callGrepTool({
      pattern: "export",
      path: filePath,
      literal: true,
      summary: true,
    });

    const summaryScoped = await callGrepTool({
      pattern: "export",
      path: filePath,
      literal: true,
      summary: true,
      scope: "symbol",
    });

    expect(getTextContent(summaryScoped)).toBe(getTextContent(summaryBaseline));
    expect(summaryScoped.details?.ptcValue).toEqual(summaryBaseline.details?.ptcValue);

    const normal = await callGrepTool({
      pattern: "createDemoDirectory",
      path: filePath,
      literal: true,
      context: 1,
    });

    expect(getTextContent(normal)).toContain("--- small.ts (1 matches) ---");
    expect(normal.details?.ptcValue?.records).toHaveLength(3);
    expect((normal.details?.ptcValue as any).scopes).toBeUndefined();
  });

  it("keeps scopeContext off the model schema", async () => {
    const tool = await getGrepTool();
    expect(tool.parameters.properties.scopeContext).toBeUndefined();
  });
});
