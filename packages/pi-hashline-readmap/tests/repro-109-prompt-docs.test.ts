import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registerFindTool } from "../src/find.js";
import { registerLsTool } from "../src/ls.js";
import { registerWriteTool } from "../src/write.js";

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

describe("repro 109 — prompt docs alignment", () => {
  it("uses compact descriptions while keeping ls, find, and write prompt docs", () => {
    const lsTool = captureTool(registerLsTool);
    const findTool = captureTool(registerFindTool);
    const writeTool = captureTool(registerWriteTool);

    const lsPrompt = promptPath("ls.md");
    const findPrompt = promptPath("find.md");
    const writePrompt = promptPath("write.md");

    expect(lsTool.description).toBe("List one directory.");
    expect(findTool.description).toBe("Find files by glob, respecting .gitignore.");
    expect(existsSync(writePrompt)).toBe(true);
    expect(writeTool.description).toBe("Create or overwrite a file and return anchors.");
    expect(firstParagraph(lsPrompt)).toContain("dotfiles are included");
    expect(firstParagraph(findPrompt)).toContain("nested `.gitignore`");
    expect(firstParagraph(writePrompt)).toContain("overwrites existing files");
  });

  it("documents hash mismatch recovery and all valid anchor sources in prompts/edit.md", () => {
    const content = readFileSync(promptPath("edit.md"), "utf8");

    expect(content).toContain("hash mismatch");
    expect(content).toContain(">>>");
    expect(content).toContain("set_line");
    expect(content).toContain("replace_lines");
    expect(content).toContain("insert_after");
    expect(content).toContain("replace");
    expect(content).toContain("read");
    expect(content).toContain("grep");
    expect(content).toContain("ast_search");
    expect(content).toContain("write");
  });
});
