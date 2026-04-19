import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import piExaExtension from "../../index.js";

describe("piExaExtension", () => {
  it("registers the web_search tool", () => {
    const registeredTools: Array<{ name: string }> = [];
    const api = {
      registerTool(tool: { name: string }) {
        registeredTools.push(tool);
      },
    } as unknown as ExtensionAPI;

    piExaExtension(api);

    expect(registeredTools.map((tool) => tool.name)).toContain("web_search");
  });
});
