import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { loadConfig } from "./config.js";
import { createWebSearchTool } from "./web-search.js";

export { loadConfig } from "./config.js";
export type { ExaExtensionConfig, ExaSearchType } from "./types.js";
export type {
  ExaSearchClient,
  ExaSearchResponse,
  WebSearchToolDeps,
  WebSearchToolInput,
} from "./web-search.js";
export { buildMissingApiKeyMessage, createWebSearchTool, formatResults } from "./web-search.js";

export default function piExaExtension(pi: ExtensionAPI): void {
  // Load config once during registration so the module surfaces obvious parse
  // errors early, but the tool itself resolves config again at execute time so
  // env var changes still take effect without a rebuild.
  loadConfig(process.cwd());
  pi.registerTool(createWebSearchTool());
}
