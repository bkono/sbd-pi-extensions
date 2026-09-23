import { describe, expect, it, vi } from "vitest";
import { registerBashRendererTool } from "../src/bash-renderer.js";

function capturePi() {
  let registered: any;
  return {
    pi: {
      registerTool: vi.fn((tool: any) => {
        registered = tool;
      }),
    },
    get tool() {
      return registered;
    },
  };
}

describe("bash renderer provider-visible metadata", () => {
  it("uses compact local metadata and still delegates execution", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const createBuiltInBashTool = vi.fn(() => ({
      description: "VERBOSE BUILTIN BASH DESCRIPTION THAT SHOULD NOT BE PROVIDER VISIBLE",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "VERBOSE BUILTIN COMMAND PARAMETER DESCRIPTION" },
        },
      },
      execute,
    }));
    const captured = capturePi();

    const tool = registerBashRendererTool(captured.pi as any, {
      cwd: "/tmp/project",
      createBuiltInBashTool,
    });

    expect(captured.tool).toBe(tool);
    expect(tool.description).toEqual(expect.any(String));
    expect(tool.description).not.toBe(
      "VERBOSE BUILTIN BASH DESCRIPTION THAT SHOULD NOT BE PROVIDER VISIBLE",
    );
    expect(tool.parameters.properties.command.description).not.toBe(
      "VERBOSE BUILTIN COMMAND PARAMETER DESCRIPTION",
    );
    expect(tool.parameters.properties.command.type).toBe("string");
    expect(tool.parameters.properties.timeout.type).toBe("number");
    expect(tool.parameters.required).toContain("command");

    await tool.execute("call-1", { command: "npm test", timeout: 30 }, undefined, undefined, {
      cwd: "/tmp/project",
    });
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { command: "npm test", timeout: 30 },
      undefined,
      undefined,
    );
  });
});
