import { StringEnum, Type } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Exa } from "exa-js";

import { loadConfig } from "./config.js";
import type { ExaExtensionConfig, ExaSearchType } from "./types.js";

export interface ExaSearchClient {
  search: (
    query: string,
    options?: {
      type?: ExaSearchType;
      numResults?: number;
    },
  ) => Promise<ExaSearchResponse>;
}

export interface ExaSearchResponse {
  results: Array<{
    title: string | null;
    url: string;
    publishedDate?: string;
    author?: string;
    score?: number;
    text?: string;
  }>;
}

export interface WebSearchToolInput {
  label: string;
  query: string;
  num_results?: number;
  type?: ExaSearchType;
}

export interface WebSearchToolDeps {
  loadConfig?: (cwd?: string) => ExaExtensionConfig;
  createClient?: (apiKey: string) => ExaSearchClient;
}

const webSearchSchema = Type.Object({
  label: Type.String({
    description: "Brief description of what you're searching for (shown to user)",
  }),
  query: Type.String({ description: "Search query" }),
  num_results: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10, default comes from config)",
      minimum: 1,
      maximum: 10,
    }),
  ),
  type: Type.Optional(
    StringEnum(["neural", "keyword", "auto"] as const, {
      description:
        "Search type: 'neural' for semantic search, 'keyword' for exact terms, 'auto' to let Exa decide",
    }),
  ),
});

function buildMissingApiKeyMessage(): string {
  return (
    "web_search requires an Exa API key. Set PI_EXA_API_KEY (or EXA_API_KEY), " +
    'or add { "apiKey": "exa-..." } to ~/.pi/exa-config.json or <cwd>/.pi/exa-config.json.'
  );
}

function defaultCreateClient(apiKey: string): ExaSearchClient {
  return new Exa(apiKey) as ExaSearchClient;
}

export function formatResults(
  query: string,
  results: ExaSearchResponse["results"],
  maxTextPerResult: number,
): string {
  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  const parts: string[] = [
    `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":`,
  ];

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    parts.push(`\n## ${i + 1}. ${result.title ?? "(no title)"}`);
    parts.push(result.url);

    const meta: string[] = [];
    if (result.publishedDate) meta.push(`Published: ${result.publishedDate}`);
    if (result.author) meta.push(`Author: ${result.author}`);
    if (meta.length > 0) parts.push(meta.join(" · "));

    if (result.text) {
      const excerpt =
        result.text.length > maxTextPerResult
          ? `${result.text.slice(0, maxTextPerResult).trim()}…`
          : result.text.trim();
      parts.push(`\n${excerpt}`);
    }
  }

  return parts.join("\n");
}

export function createWebSearchTool(deps: WebSearchToolDeps = {}) {
  const loadConfigImpl = deps.loadConfig ?? loadConfig;
  const createClient = deps.createClient ?? defaultCreateClient;

  return {
    name: "web_search",
    label: "Web Search",
    description:
      'Search the web via Exa. Returns ranked results with titles, URLs, and text excerpts. Use `type: "neural"` for semantic/conceptual queries, `keyword` for exact-term matches, or `auto` to let Exa choose.',
    promptSnippet: "Search the public web for current information using Exa.",
    promptGuidelines: [
      "Use this tool when you need fresh or public-web information that may not be in the model's training data.",
      'Prefer `type: "keyword"` for exact phrases, package names, identifiers, error strings, or quoted text.',
      'Prefer `type: "neural"` for broader research, discovery, or conceptual lookups.',
    ],
    parameters: webSearchSchema,
    async execute(
      _toolCallId: string,
      params: WebSearchToolInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const config = loadConfigImpl(ctx.cwd);
      if (!config.apiKey) {
        throw new Error(buildMissingApiKeyMessage());
      }

      const client = createClient(config.apiKey);
      const numResults = params.num_results ?? config.defaultNumResults;
      const searchType = params.type ?? config.defaultSearchType;
      const response = await client.search(params.query, {
        type: searchType,
        numResults,
      });

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      return {
        content: [
          {
            type: "text" as const,
            text: formatResults(params.query, response.results, config.maxTextPerResult),
          },
        ],
        details: undefined,
      };
    },
  };
}

export { buildMissingApiKeyMessage };
