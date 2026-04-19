import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

export type BeadworkAliasSubcommand =
  | "status"
  | "ready"
  | "list"
  | "show"
  | "scope"
  | "workers"
  | "delegate"
  | "land"
  | "cancel"
  | "cleanup"
  | "run"
  | "off"
  | "adopt";

export const BEADWORK_ALIAS_COMMANDS: Array<{
  name: `bw:${string}`;
  subcommand: BeadworkAliasSubcommand;
  description: string;
}> = [
  { name: "bw:status", subcommand: "status", description: "Show beadwork status" },
  { name: "bw:ready", subcommand: "ready", description: "Show ready beadwork work" },
  { name: "bw:list", subcommand: "list", description: "List beadwork issues" },
  { name: "bw:show", subcommand: "show", description: "Show one beadwork issue" },
  { name: "bw:scope", subcommand: "scope", description: "Set or clear beadwork scope" },
  { name: "bw:workers", subcommand: "workers", description: "Inspect beadwork workers" },
  { name: "bw:delegate", subcommand: "delegate", description: "Delegate a beadwork ticket" },
  { name: "bw:land", subcommand: "land", description: "Land a deferred worker" },
  { name: "bw:cancel", subcommand: "cancel", description: "Cancel an active worker" },
  {
    name: "bw:cleanup",
    subcommand: "cleanup",
    description: "Cleanup landed worker artifacts",
  },
  { name: "bw:run", subcommand: "run", description: "Run a bounded epic loop" },
  { name: "bw:off", subcommand: "off", description: "Reset beadwork session state" },
  { name: "bw:adopt", subcommand: "adopt", description: "Adopt a markdown plan into beadwork" },
];

export function registerBeadworkCommandAliases(input: {
  pi: ExtensionAPI;
  dispatch: (
    subcommand: string,
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void> | void;
  getAliasCompletions?: (
    subcommand: BeadworkAliasSubcommand,
    prefix: string,
  ) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
}): void {
  for (const alias of BEADWORK_ALIAS_COMMANDS) {
    const getArgumentCompletions = input.getAliasCompletions
      ? (prefix: string) => input.getAliasCompletions?.(alias.subcommand, prefix) ?? null
      : undefined;
    input.pi.registerCommand(alias.name, {
      description: alias.description,
      getArgumentCompletions,
      handler: async (args, ctx) => {
        await input.dispatch(alias.subcommand, args, ctx);
      },
    });
  }
}
