import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OrchestrationGroupState } from "../orchestration/index.js";
import type { SubsessionManager } from "../subsessions/manager.js";
import { runHalt } from "../tools/halt.js";
import type { AgentTree } from "../tree.js";

export function createHaltHandler(
  tree: AgentTree,
  subsessionManager: SubsessionManager,
  groups: OrchestrationGroupState,
) {
  return async function handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const trimmed = args.trim();

    if (!trimmed) {
      ctx.ui.notify("Usage: /halt <id | name | group | all>", "error");
      return;
    }

    const result = await runHalt(trimmed, tree, subsessionManager, groups);
    ctx.ui.notify(result.text, result.error ? "error" : "info");
  };
}
