import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
describe("extension entry point (AC8)", () => {
  it("index.ts exists", () => {
    expect(existsSync(resolve(root, "index.ts"))).toBe(true);
  });
  it("index.ts default export is a function with one argument", async () => {
    const mod = await import(pathToFileURL(resolve(root, "index.ts")).href);
    expect(typeof mod.default).toBe("function");
    expect(mod.default.length).toBe(1);
  });
  it("src/index.ts imports read/edit/grep with .js specifiers", () => {
    const source = readFileSync(resolve(root, "src/index.ts"), "utf8");
    expect(source).toContain('import { registerReadTool } from "./read.js";');
    expect(source).toContain('import { registerEditTool } from "./edit.js";');
    expect(source).toContain('import { registerGrepTool } from "./grep.js";');
  });
  it("src/index.ts default export is the extension function", async () => {
    const mod = await import(pathToFileURL(resolve(root, "src/index.ts")).href);
    expect(typeof mod.default).toBe("function");
    expect(mod.default.length).toBe(1);
  });
  it("registers ast_search tool", async () => {
    const mod = await import(pathToFileURL(resolve(root, "index.ts")).href);
    const tools: string[] = [];
    const mockPi = {
      registerTool(def: any) {
        tools.push(def.name);
      },
      on() {},
      events: { emit() {}, on() {} },
    };
    mod.default(mockPi as any);
    expect(tools).toContain("ast_search");
  });
});
