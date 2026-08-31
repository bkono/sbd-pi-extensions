import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "../agents.js";
import { getConfig } from "../config.js";

export const ListAgentsParams = Type.Object(
  {},
  {
    description: "List all available agents for spawn and orchestrate. No parameters required.",
  },
);

export interface AgentInfo {
  name: string;
  description: string;
  source: string;
  model?: string;
  thinking?: string;
}

export function listAgents() {
  return async function execute(
    _toolCallId: string,
    _params: Record<string, never>,
    _signal: AbortSignal | undefined,
    _onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<AgentInfo[]>> {
    const { agents } = discoverAgents(ctx.cwd, "both");
    const piConfig = getConfig(ctx);

    const lines: string[] = [];
    const details: AgentInfo[] = [];

    // Built-in ephemeral minion (only when allowed)
    if (piConfig.allowEphemeral) {
      lines.push(
        "- minion (built-in): General-purpose ephemeral minion with default capabilities. Used when no agent name is specified.",
      );
      details.push({
        name: "minion",
        description: "General-purpose ephemeral minion",
        source: "built-in",
      });
    }

    for (const a of agents) {
      const model = a.model ? ` [model: ${a.model}]` : "";
      const thinking = a.thinking ? ` [thinking: ${a.thinking}]` : "";
      lines.push(`- ${a.name} (${a.source}): ${a.description}${model}${thinking}`);
      details.push({
        name: a.name,
        description: a.description,
        source: a.source,
        model: a.model,
        thinking: a.thinking,
      });
    }

    return {
      content: [{ type: "text", text: `Available agents:\n${lines.join("\n")}` }],
      details,
    };
  };
}
