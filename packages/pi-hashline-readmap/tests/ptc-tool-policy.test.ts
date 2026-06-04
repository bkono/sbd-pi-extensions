import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { registerEditTool } from "../src/edit.js";
import { registerFindTool } from "../src/find.js";
import { registerGrepTool } from "../src/grep.js";
import { registerLsTool } from "../src/ls.js";
import { getHashlineToolPtcPolicy, HASHLINE_TOOL_PTC_POLICY } from "../src/ptc-tool-policy.js";
import { registerReadTool } from "../src/read.js";
import { registerSgTool } from "../src/sg.js";
import { registerWriteTool } from "../src/write.js";

function captureInlinePtc(): Record<string, any> {
  const tools: Record<string, any> = {};
  const pi = {
    registerTool(def: any) {
      tools[def.name] = def;
    },
  };

  registerReadTool(pi as any);
  registerGrepTool(pi as any);
  registerSgTool(pi as any);
  registerEditTool(pi as any);
  registerWriteTool(pi as any);
  registerLsTool(pi as any);
  registerFindTool(pi as any);

  const inline: Record<string, any> = {};
  for (const [name, def] of Object.entries(tools)) {
    expect(def.ptc, `tool "${name}" is missing an inline ptc block`).toBeDefined();
    inline[name] = def.ptc;
  }
  return inline;
}

describe("hashline tool ptc policy drift guard", () => {
  it("getHashlineToolPtcPolicy returns the exported singleton", () => {
    expect(getHashlineToolPtcPolicy()).toBe(HASHLINE_TOOL_PTC_POLICY);
  });

  it("package root and src entry point expose the shared policy", async () => {
    const root = resolve(__dirname, "..");
    const [rootMod, srcMod] = await Promise.all([
      import(pathToFileURL(resolve(root, "index.ts")).href),
      import(pathToFileURL(resolve(root, "src/index.ts")).href),
    ]);

    expect(rootMod.HASHLINE_TOOL_PTC_POLICY).toBe(HASHLINE_TOOL_PTC_POLICY);
    expect(rootMod.getHashlineToolPtcPolicy()).toBe(HASHLINE_TOOL_PTC_POLICY);
    expect(srcMod.HASHLINE_TOOL_PTC_POLICY).toBe(HASHLINE_TOOL_PTC_POLICY);
    expect(srcMod.getHashlineToolPtcPolicy()).toBe(HASHLINE_TOOL_PTC_POLICY);
  });

  it("policy key set equals the live runtime tool set without the removed nu tool", () => {
    const inline = captureInlinePtc();
    expect(Object.keys(HASHLINE_TOOL_PTC_POLICY.tools).sort()).toEqual(Object.keys(inline).sort());
    expect(HASHLINE_TOOL_PTC_POLICY.tools).not.toHaveProperty("nu");
  });

  it("each policy entry matches the live tool's inline ptc", () => {
    const inline = captureInlinePtc();
    for (const [name, entry] of Object.entries(HASHLINE_TOOL_PTC_POLICY.tools)) {
      const ptc = inline[name];
      expect(ptc, `no inline ptc for policy tool "${name}"`).toBeDefined();
      expect(entry.toolName, `toolName for "${name}"`).toBe(name);
      expect(entry.helperName, `helperName for "${name}"`).toBe(ptc.pythonName);
      expect(entry.mutability, `mutability for "${name}"`).toBe(ptc.policy);
      expect(entry.defaultExposure, `defaultExposure for "${name}"`).toBe(ptc.defaultExposure);
    }
  });
});
