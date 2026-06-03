import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

describe("prompts directory (AC15)", () => {
  it("prompts directory exists", () => {
    expect(existsSync(resolve(root, "prompts"))).toBe(true);
  });

  it("prompts contains at least one .md file", () => {
    const promptsDir = resolve(root, "prompts");
    expect(existsSync(promptsDir)).toBe(true);
    const files = readdirSync(promptsDir);
    expect(files.some((f) => f.endsWith(".md"))).toBe(true);
  });

  it("read prompt documents hashlines, truncation maps, image behavior, and symbol bundles", () => {
    const readPrompt = readFileSync(resolve(root, "prompts/read.md"), "utf8");

    expect(readPrompt).toContain("LINE:HASH|content");
    expect(readPrompt).toContain("{{DEFAULT_MAX_LINES}}");
    expect(readPrompt).toContain("{{DEFAULT_MAX_BYTES}}");
    expect(readPrompt).toContain("structural map");
    expect(readPrompt).toContain("read({ offset, limit })");
    expect(readPrompt).toContain("Images return attachments");
    expect(readPrompt).toContain('bundle: "local"');
    expect(readPrompt).toContain("Fuzzy");
  });

  it("sg prompt exists and documents metavariables, workflow, and the ast_search snippet", () => {
    const sgPromptPath = resolve(root, "prompts/sg.md");
    expect(existsSync(sgPromptPath)).toBe(true);

    const content = readFileSync(sgPromptPath, "utf8");
    expect(content).toContain("$NAME");
    expect(content).toContain("$$$ARGS");
    expect(content).toContain("$_");
    expect(content).toContain("code shape");
    expect(content.toLowerCase()).toContain("tips");
    expect(content.toLowerCase()).toContain("edit");
  });
});
