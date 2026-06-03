import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registerFindTool } from "../src/find.js";

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

describe("find prompt loading", () => {
  it("uses compact provider-visible metadata and keeps prompt details in prompts/find.md", () => {
    const tool = captureTool(registerFindTool);
    expect(tool.description).toBe("Find files by glob, respecting .gitignore.");
    expect(firstParagraph(promptPath("find.md"))).toContain("nested `.gitignore`");
  });

  it("documents basename matching, filters, sorting, and limit order", () => {
    const content = readFileSync(promptPath("find.md"), "utf8");

    expect(content).toContain("regex: true");
    expect(content).toContain("basename");
    expect(content).toContain("modified strictly after");
    expect(content).toContain("Filtering and sorting happen before `limit`");
    expect(content).toContain("minSize");
    expect(content).toContain("maxSize");
  });
});
