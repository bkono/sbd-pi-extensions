import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { type ParsedModelOverride, parseModelOverride } from "../argv.js";
import type { BeadworkIssueDetail } from "../types.js";

export type DelegateClarifyResult = {
  ticketId: string;
  epicId?: string;
  modelOverride?: ParsedModelOverride;
};

export class DelegateClarifyComponent implements Component {
  private modelOverrideText: string;
  private error?: string;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly issue: BeadworkIssueDetail,
    private readonly done: (result: DelegateClarifyResult | undefined) => void,
    initialModelOverride = "",
  ) {
    this.modelOverrideText = initialModelOverride;
  }

  setModelOverride(value: string): void {
    this.modelOverrideText = value;
    this.error = undefined;
    this.tui.requestRender();
  }

  submit(): void {
    try {
      const normalized = this.modelOverrideText.trim();
      this.done({
        ticketId: this.issue.id,
        epicId: this.issue.parentId,
        modelOverride: normalized ? parseModelOverride(normalized) : undefined,
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.tui.requestRender();
    }
  }

  cancel(): void {
    this.done(undefined);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      this.submit();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
      this.cancel();
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      if (this.modelOverrideText.length > 0) {
        this.modelOverrideText = this.modelOverrideText.slice(0, -1);
        this.error = undefined;
        this.tui.requestRender();
      }
      return;
    }

    if (data.length === 1 && data >= " " && data !== "\u007f") {
      this.modelOverrideText += data;
      this.error = undefined;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const lines = [
      this.theme.fg("accent", this.theme.bold("Delegate ticket")),
      `${this.issue.id} · ${this.issue.title}`,
      `Parent epic: ${this.issue.parentId ?? "none"}`,
      "",
      `Model override: ${this.modelOverrideText || "(default worker model)"}`,
      "Type provider/model for a one-off worker override, or leave it empty to keep the configured default.",
      "",
      this.error
        ? `Error: ${this.error}`
        : "type to edit • enter delegates • backspace deletes • esc/q cancels",
    ];

    return lines.flatMap((line) =>
      wrapTextWithAnsi(line, Math.max(1, width)).map((wrapped) => truncateToWidth(wrapped, width)),
    );
  }

  invalidate(): void {}
}

export async function openDelegateClarify(
  ctx: ExtensionCommandContext,
  input: { issue: BeadworkIssueDetail; initialModelOverride?: string },
): Promise<DelegateClarifyResult | undefined> {
  return ctx.ui.custom<DelegateClarifyResult | undefined>(
    (tui, theme, _keybindings, done) =>
      new DelegateClarifyComponent(
        tui,
        theme,
        input.issue,
        done as (result: DelegateClarifyResult | undefined) => void,
        input.initialModelOverride,
      ),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: 72,
        maxHeight: "70%",
        margin: 1,
      },
    },
  );
}
