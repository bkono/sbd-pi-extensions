import { afterEach, describe, expect, it, vi } from "vitest";
import { collectHashlineSystemPromptMetadata } from "./helpers/pi-prompt-metadata-harness.js";

const EXPECTED_TOOLS = ["read", "edit", "grep", "find", "ls", "write", "ast_search"] as const;

describe("Pi system prompt metadata integration", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("renders hashline override snippets and flat tool-named guidelines through Pi registration", async () => {
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<any>("node:child_process");
      return {
        ...actual,
        execFileSync: vi.fn(() => Buffer.from("0.111.0\n")),
      };
    });

    const { systemPrompt, snippets, guidelinesByTool, activeToolNames } =
      await collectHashlineSystemPromptMetadata([...EXPECTED_TOOLS]);
    expect(activeToolNames).toEqual([...EXPECTED_TOOLS]);

    for (const toolName of EXPECTED_TOOLS) {
      const snippet = snippets[toolName];
      expect(snippet, `${toolName} promptSnippet`).toBeTruthy();
      expect(snippet).not.toContain("\n");
      expect(snippet.length, `${toolName} promptSnippet should stay concise`).toBeLessThanOrEqual(
        140,
      );
      expect(systemPrompt).toContain(`- ${toolName}: ${snippet}`);

      const guidelines = guidelinesByTool[toolName];
      expect(guidelines.length, `${toolName} promptGuidelines`).toBeGreaterThan(0);
      for (const guideline of guidelines) {
        expect(guideline.toLowerCase(), `${toolName} guideline should name its tool`).toContain(
          toolName.toLowerCase(),
        );
        expect(guideline, `${toolName} guideline should avoid ambiguous phrasing`).not.toMatch(
          /\bthis tool\b/i,
        );
        expect(systemPrompt).toContain(`- ${guideline}`);
      }
    }
  }, 20_000);
});
