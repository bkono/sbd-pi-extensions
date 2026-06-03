import {
  buildContextHygieneMetadata,
  buildFileResource,
  buildSymbolResource,
  type ContextHygieneMetadata,
  type ContextHygieneRehydrateDescriptor,
  type ContextHygieneResource,
} from "./context-hygiene.js";
import type { PtcLine, PtcRange } from "./ptc-value.js";

export interface SgOutputFile {
  displayPath: string;
  path: string;
  ranges: PtcRange[];
  lines: PtcLine[];
  symbols?: Array<{ name: string; kind?: string }>;
}

export interface BuildSgOutputInput {
  pattern: string;
  files: SgOutputFile[];
  rehydrate?: ContextHygieneRehydrateDescriptor | null;
}

export interface SgOutputResult {
  text: string;
  ptcValue: {
    tool: "ast_search";
    files: Array<{
      path: string;
      ranges: PtcRange[];
      lines: PtcLine[];
    }>;
  };
  contextHygiene: ContextHygieneMetadata;
}

export function buildSgOutput(input: BuildSgOutputInput): SgOutputResult {
  if (input.files.length === 0) {
    return {
      text: `No matches found for pattern: ${input.pattern}`,
      ptcValue: {
        tool: "ast_search",
        files: [],
      },
      contextHygiene: buildContextHygieneMetadata({
        tool: "ast_search",
        classification: "search-context",
        resources: [],
        rehydrate: input.rehydrate ?? undefined,
      }),
    };
  }

  const blocks: string[] = [];
  for (const file of input.files) {
    blocks.push(`--- ${file.displayPath} ---`);
    for (const line of file.lines) {
      blocks.push(`>>${line.anchor}|${line.display}`);
    }
  }

  const contextHygieneResources: ContextHygieneResource[] = [];
  for (const file of input.files) {
    contextHygieneResources.push(buildFileResource(file.path));
    for (const symbol of file.symbols ?? []) {
      contextHygieneResources.push(buildSymbolResource(file.path, symbol.name, symbol.kind));
    }
  }

  return {
    text: blocks.join("\n"),
    ptcValue: {
      tool: "ast_search",
      files: input.files.map((file) => ({
        path: file.path,
        ranges: file.ranges.map((range) => ({ ...range })),
        lines: file.lines.map((line) => ({ ...line })),
      })),
    },
    contextHygiene: buildContextHygieneMetadata({
      tool: "ast_search",
      classification: "search-context",
      resources: contextHygieneResources,
      rehydrate: input.rehydrate ?? undefined,
    }),
  };
}
