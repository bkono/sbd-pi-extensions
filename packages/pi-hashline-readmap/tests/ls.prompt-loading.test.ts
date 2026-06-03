import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registerLsTool } from "../src/ls.js";

const promptPath = (name: string) => fileURLToPath(new URL(`../prompts/${name}`, import.meta.url));

function firstParagraph(path: string): string {
  const content = readFileSync(path, "utf8").trim();
  return content.split(/\n\s*\n/, 1)[0]?.trim() ?? content;
}

function captureTool(register: (pi: any) => void) {
  let tool: any;
  register({
    registerTool(def: any) {
      tool = def;
    },
  });
  return tool;
}

describe("ls prompt loading", () => {
  it("uses compact provider-visible metadata and keeps prompt details in prompts/ls.md", () => {
    const tool = captureTool(registerLsTool);
    expect(tool.description).toBe("List one directory.");
    expect(firstParagraph(promptPath("ls.md"))).toContain("dotfiles are included");
  });

  it("documents single-directory output and routing to find/read", () => {
    const content = readFileSync(promptPath("ls.md"), "utf8");

    expect(content).toContain("List one directory");
    expect(content).toContain("dotfiles are included");
    expect(content).toContain("Output is one entry per line");
    expect(content).toContain("find` for recursive discovery");
    expect(content).toContain("read` for file contents");
  });
});
