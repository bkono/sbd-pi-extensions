import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { registerBashRendererTool } from "../src/bash-renderer.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function textOf(component: any): string {
  return component?.text ?? component?.render?.(80)?.join("\n") ?? "";
}

describe("bash renderer wrapper", () => {
  it("delegates execution to a built-in bash tool and renders compact summaries", async () => {
    const execute = vi.fn(async (_toolCallId, _params, _signal, _onUpdate) => ({
      content: [{ type: "text", text: "ok\n" }],
      details: { delegated: true },
    }));
    const createBuiltIn = vi.fn(() => ({
      name: "bash",
      label: "bash",
      description: "bash",
      parameters: {},
      execute,
    }));
    let registered: any;
    registerBashRendererTool(
      {
        registerTool(def: any) {
          registered = def;
        },
      } as any,
      { createBuiltInBashTool: createBuiltIn, cwd: "/tmp/work" },
    );

    expect(textOf(registered.renderCall({ command: "npm test" }, theme))).toBe("bash npm test");
    await expect(
      registered.execute("call-1", { command: "npm test" }, undefined, undefined, {
        cwd: "/tmp/work",
      }),
    ).resolves.toMatchObject({ details: { delegated: true } });
    expect(createBuiltIn).toHaveBeenCalledWith("/tmp/work");
    expect(execute).toHaveBeenCalledWith("call-1", { command: "npm test" }, undefined, undefined);
  });

  it("keeps renderResult diagnostics clean for intentionally unused theme", () => {
    const source = readFileSync(new URL("../src/bash-renderer.ts", import.meta.url), "utf8");
    expect(source).not.toContain("renderResult(result: any, optionsArg: any, theme: any");
  });

  it("uses compact local metadata instead of forwarding verbose built-in metadata", () => {
    const params = {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    };
    const builtIn = {
      name: "bash",
      label: "bash",
      description: "real bash description",
      parameters: params,
      execute: async () => ({ content: [{ type: "text", text: "" }] }),
    };
    let registered: any;
    registerBashRendererTool(
      {
        registerTool(def: any) {
          registered = def;
        },
      } as any,
      { createBuiltInBashTool: () => builtIn, cwd: "/tmp/work" },
    );
    expect(registered.description).toEqual(expect.any(String));
    expect(registered.description).not.toBe(builtIn.description);
    expect(registered.parameters).not.toBe(params);
    expect(registered.parameters.properties.command.type).toBe("string");
    expect(registered.parameters.required).toContain("command");
  });
});
