/**
 * Pi Hello World Extension
 *
 * A minimal pi extension that registers a hello_world tool
 * and a /hello command.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // Greet on session start
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("👋 Hello World extension loaded!", "info");
  });

  // Register a tool the LLM can call
  pi.registerTool({
    name: "hello_world",
    label: "Hello World",
    description: "A simple greeting tool that says hello to someone",
    promptSnippet: "Greet someone by name with a friendly hello",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the person to greet" }),
    }),

    async execute(_toolCallId, params) {
      const greeting = `Hello, ${params.name}! 👋 Welcome from @solvedbydev/pi-hello-world-extension.`;
      return {
        content: [{ type: "text", text: greeting }],
        details: { greeted: params.name },
      };
    },
  });

  // Register a /hello command
  pi.registerCommand("hello", {
    description: "Say hello (usage: /hello [name])",
    handler: async (args, ctx) => {
      const name = args?.trim() || "World";
      ctx.ui.notify(`Hello, ${name}! 👋`, "info");
    },
  });
}
