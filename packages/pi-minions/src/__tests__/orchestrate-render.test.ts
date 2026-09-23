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
  it("projects accepted identities and rejected input into tool and UI output", () => {
    const text = formatOrchestrateText(partial);
    const rendered = textOf(
      renderOrchestrateResult({ content: [], details: partial }, options, theme, {
        isError: false,
      }),
    );
    expect(text).toContain(partial.groupId);
    for (const output of [text, rendered]) {
      expect(output).toContain(summarizeOrchestrate(partial));
      for (const child of partial.accepted) {
        expect(output).toContain(child.childId);
        expect(output).toContain(child.description);
      }
      for (const rejection of partial.rejected) {
        expect(output).toContain(rejection.reason);
        expect(output).toContain(rejection.value!);
      }
    }
  });

  it.each([false, true])("uses error styling for all-rejected results (isError=%s)", (isError) => {
    const rejected: OrchestrateResult = { ...partial, accepted: [] };
    const colors: string[] = [];
    const recordingTheme = {
      ...theme,
      fg: (color: string, text: string) => {
        colors.push(color);
        return text;
      },
    } as Theme;
    const rendered = textOf(
      renderOrchestrateResult({ content: [], details: rejected }, options, recordingTheme, {
        isError,
      }),
    );
    expect(colors[0]).toBe("error");
    expect(rendered).toContain(summarizeOrchestrate(rejected));
    expect(rendered).toContain(rejected.rejected[0]!.reason);
  });

  it("previews the first task description in the call renderer", () => {
    const description = "description-sentinel";
    expect(
      textOf(renderOrchestrateCall({ tasks: [{ task: "do work", description }] }, theme, {})),
    ).toContain(description);
  });

  it.each([false, true])("passes through fallback text (isError=%s)", (isError) => {
    const text = "fallback-sentinel";
    expect(
      textOf(
        renderOrchestrateResult({ content: [{ type: "text", text }] }, options, theme, { isError }),
      ),
    ).toBe(text);
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
