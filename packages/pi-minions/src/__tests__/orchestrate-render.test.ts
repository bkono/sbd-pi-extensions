import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { minionSpawnRenderer } from "../renderers/minion-spawn.js";
import {
  formatOrchestrateText,
  renderOrchestrateCall,
  renderOrchestrateResult,
  summarizeOrchestrate,
} from "../renderers/orchestrate.js";
import type { OrchestrateResult } from "../types.js";
import { emptyUsage } from "../types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const options: ToolRenderResultOptions = { expanded: false, isPartial: false };

function textOf(component: { text?: string } | undefined): string {
  return component?.text ?? "";
}

const partial: OrchestrateResult = {
  groupId: "grp-1",
  accepted: [
    { childId: "mn-a", description: "Registry refactor", state: "starting" },
    { childId: "mn-b", description: "Review registry", state: "starting" },
  ],
  rejected: [{ index: 2, reason: "unknown taskType", value: "validation" }],
};

describe("orchestrate renderer", () => {
  it("summarizes partial acceptance as starting and rejected, never completed", () => {
    expect(summarizeOrchestrate(partial)).toBe("2 starting, 1 rejected");
    const text = formatOrchestrateText(partial);
    expect(text).toContain("2 starting, 1 rejected");
    expect(text).toContain("unknown taskType (validation)");
    expect(text).not.toMatch(/\bcompleted\b/);
    expect(
      textOf(
        renderOrchestrateResult({ content: [], details: partial }, options, theme, {
          isError: false,
        }),
      ),
    ).toContain("2 starting, 1 rejected");
  });

  it("renders all-rejected with error semantics and no completed label", () => {
    const rejected: OrchestrateResult = {
      groupId: "",
      accepted: [],
      rejected: [
        { index: 0, reason: "missing description" },
        { index: 1, reason: "unknown taskType", value: "validation" },
      ],
    };
    const text = formatOrchestrateText(rejected);
    expect(text).toContain("Orchestration rejected: 0 starting, 2 rejected.");
    expect(text).not.toMatch(/\bcompleted\b/);
    expect(
      textOf(
        renderOrchestrateResult(
          { content: [{ type: "text", text }], details: rejected },
          options,
          theme,
          {
            isError: true,
          },
        ),
      ),
    ).toContain("0 starting, 2 rejected");
  });

  it("call renderer uses registered vocabulary", () => {
    const text = textOf(
      renderOrchestrateCall(
        { tasks: [{ task: "do work", description: "Registry refactor" }] },
        theme,
        {},
      ),
    );
    expect(text).toContain("orchestrate");
    expect(text).toContain("registered");
    expect(text).not.toMatch(/\bcompleted\b/);
  });

  it("does not label a successful fallback as completed", () => {
    const text = textOf(
      renderOrchestrateResult(
        { content: [{ type: "text", text: "tool succeeded" }] },
        options,
        theme,
        { isError: false },
      ),
    );
    expect(text).not.toMatch(/\bcompleted\b/);
  });
});

describe("foreground spawn renderer", () => {
  it("still labels completed spawn results as completed", () => {
    const rendered = minionSpawnRenderer(
      {
        details: {
          id: "mn-spawn",
          name: "alpha",
          agentName: "ephemeral",
          task: "review the auth flow",
          status: "completed",
          usage: emptyUsage(),
          finalOutput: "auth looks fine",
        },
      },
      { expanded: false, outputPad: 0 },
      theme,
    );
    expect(rendered?.header).toContain("✓");
    expect(rendered?.header).toContain("alpha");
  });
});
