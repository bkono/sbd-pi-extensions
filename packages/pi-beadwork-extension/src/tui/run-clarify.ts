import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { BeadworkIssueDetail, RunUntil, SessionRunOptions, SessionState } from "../types.js";
import { renderSurface } from "./common.js";

export type RunClarifyResult = {
  epicId: string;
  options: Required<Pick<SessionRunOptions, "workers" | "until" | "noSpawn" | "dryRun">> & {
    maxCycles: number;
  };
};

export type RunClarifyDefaults = {
  workers: number;
  until: RunUntil;
  maxCycles: number;
  noSpawn: boolean;
  dryRun: boolean;
};

const RUN_FIELDS = ["workers", "until", "maxCycles", "dryRun", "noSpawn"] as const;
type RunField = (typeof RUN_FIELDS)[number];

export class RunClarifyComponent implements Component {
  private selectedIndex = 0;
  private workers: number;
  private until: RunUntil;
  private maxCycles: number;
  private dryRun: boolean;
  private noSpawn: boolean;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly epic: BeadworkIssueDetail,
    private readonly sessionState: SessionState,
    private readonly done: (result: RunClarifyResult | undefined) => void,
    defaults: RunClarifyDefaults,
  ) {
    this.workers = defaults.workers;
    this.until = defaults.until;
    this.maxCycles = defaults.maxCycles;
    this.dryRun = defaults.dryRun;
    this.noSpawn = defaults.noSpawn;
  }

  setField(field: RunField, value: number | boolean | RunUntil): void {
    switch (field) {
      case "workers":
        this.workers = Math.max(1, Math.floor(Number(value)) || 1);
        break;
      case "until":
        this.until = value === "empty" ? "empty" : "blocked";
        break;
      case "maxCycles":
        this.maxCycles = Math.max(1, Math.floor(Number(value)) || 1);
        break;
      case "dryRun":
        this.dryRun = value === true;
        break;
      case "noSpawn":
        this.noSpawn = value === true;
        break;
    }
    this.tui.requestRender();
  }

  submit(): void {
    this.done({
      epicId: this.epic.id,
      options: {
        workers: this.workers,
        until: this.until,
        maxCycles: this.maxCycles,
        dryRun: this.dryRun,
        noSpawn: this.noSpawn,
      },
    });
  }

  cancel(): void {
    this.done(undefined);
  }

  private get selectedField(): RunField {
    return RUN_FIELDS[this.selectedIndex] ?? "workers";
  }

  private cycleSelection(delta: 1 | -1): void {
    this.selectedIndex = (this.selectedIndex + delta + RUN_FIELDS.length) % RUN_FIELDS.length;
    this.tui.requestRender();
  }

  private adjustSelected(delta: 1 | -1): void {
    switch (this.selectedField) {
      case "workers":
        this.workers = Math.max(1, this.workers + delta);
        break;
      case "until":
        this.until = this.until === "blocked" ? "empty" : "blocked";
        break;
      case "maxCycles":
        this.maxCycles = Math.max(1, this.maxCycles + delta);
        break;
      case "dryRun":
        this.dryRun = !this.dryRun;
        break;
      case "noSpawn":
        this.noSpawn = !this.noSpawn;
        break;
    }
    this.tui.requestRender();
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

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.cycleSelection(-1);
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.cycleSelection(1);
      return;
    }

    if (
      matchesKey(data, Key.left) ||
      matchesKey(data, "h") ||
      matchesKey(data, Key.right) ||
      matchesKey(data, "l") ||
      data === " "
    ) {
      this.adjustSelected(matchesKey(data, Key.left) || matchesKey(data, "h") ? -1 : 1);
    }
  }

  render(width: number): string[] {
    const scope =
      this.sessionState.scope.kind === "none"
        ? "repo-wide"
        : `${this.sessionState.scope.kind}:${this.sessionState.scope.id}`;

    return renderSurface(this.theme, width, {
      title: "Run epic",
      subtitle: [
        `${this.epic.id} · ${this.epic.title}`,
        `Session: mode=${this.sessionState.mode} · scope=${scope}`,
      ],
      sections: [
        {
          title: "Run options",
          lines: RUN_FIELDS.map((field, index) => {
            const prefix = index === this.selectedIndex ? ">" : " ";
            switch (field) {
              case "workers":
                return `${prefix} Workers: ${this.workers}`;
              case "until":
                return `${prefix} Until: ${this.until}`;
              case "maxCycles":
                return `${prefix} Max cycles: ${this.maxCycles}`;
              case "dryRun":
                return `${prefix} Dry run: ${this.dryRun ? "yes" : "no"}`;
              case "noSpawn":
                return `${prefix} No spawn: ${this.noSpawn ? "yes" : "no"}`;
              default:
                return prefix;
            }
          }),
        },
      ],
      bodyHeight: 10,
      footer: "↑/↓ or j/k choose • ←/→ or h/l or space adjust • enter starts • esc/q cancels",
    });
  }

  invalidate(): void {}
}

export async function openRunClarify(
  ctx: ExtensionCommandContext,
  input: {
    epic: BeadworkIssueDetail;
    defaults: RunClarifyDefaults;
    sessionState: SessionState;
  },
): Promise<RunClarifyResult | undefined> {
  return ctx.ui.custom<RunClarifyResult | undefined>(
    (tui, theme, _keybindings, done) =>
      new RunClarifyComponent(
        tui,
        theme,
        input.epic,
        input.sessionState,
        done as (result: RunClarifyResult | undefined) => void,
        input.defaults,
      ),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: 76,
        maxHeight: "75%",
        margin: 1,
      },
    },
  );
}
