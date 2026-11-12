import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.js";
import { type ModelPolicy, type ModesConfig, packDefaults } from "./model-policy.js";
import type { AgentTree } from "./tree.js";

/**
 * The model policy for children dispatched now: the explicit pack, the session model, and pack
 * defaults from the available models and the models this session's writers ran on. Writers are
 * children that are not pack agents; before any ran, the build model or the session model.
 */
export function modelPolicyFor(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  tree: Pick<AgentTree, "getAll">,
  modes: ModesConfig,
  cwd: string,
): ModelPolicy {
  const session = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  let defaults: ModesConfig | undefined;
  const computeDefaults = (): ModesConfig => {
    const pack = new Set(
      discoverAgents(cwd, "both")
        .agents.filter((agent) => agent.packModel)
        .map((agent) => agent.name),
    );
    const ran = tree
      .getAll()
      .filter((node) => node.model && !pack.has(node.agentName ?? ""))
      .map((node) => node.model as string);
    const fallback = modes.build ?? session;
    const writers = ran.length > 0 ? ran : fallback ? [fallback] : [];
    return packDefaults({ available: ctx.modelRegistry.getAvailable(), writers });
  };
  return {
    modes,
    session,
    defaults: () => {
      defaults ??= computeDefaults();
      return defaults;
    },
  };
}
