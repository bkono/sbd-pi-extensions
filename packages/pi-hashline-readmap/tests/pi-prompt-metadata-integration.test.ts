import { afterEach, describe, expect, it, vi } from "vitest";
import { collectHashlineSystemPromptMetadata } from "./helpers/pi-prompt-metadata-harness.js";

const EXPECTED_TOOLS = ["read", "edit", "grep", "find", "ls", "write", "ast_search"] as const;

describe("Pi system prompt metadata integration", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("delivers registered snippets and guidelines through Pi registration", async () => {
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<any>("node:child_process");
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from("0.111.0\n")),
      };
    });

    const { systemPrompt, snippets, guidelinesByTool, activeToolNames } =
      await collectHashlineSystemPromptMetadata([...EXPECTED_TOOLS]);
    // Pi owns the order of active tools (it changed in 1.5); membership is the contract.
    expect([...activeToolNames].sort()).toEqual([...EXPECTED_TOOLS].sort());

    for (const toolName of EXPECTED_TOOLS) {
      const snippet = snippets[toolName];
      expect(snippet, `${toolName} promptSnippet`).toBeTruthy();
      expect(systemPrompt).toContain(`- ${toolName}: ${snippet}`);

      const guidelines = guidelinesByTool[toolName];
      expect(guidelines.length, `${toolName} promptGuidelines`).toBeGreaterThan(0);
      for (const guideline of guidelines) {
        expect(systemPrompt).toContain(`- ${guideline}`);
      }
    }
  }, 20_000);
});
