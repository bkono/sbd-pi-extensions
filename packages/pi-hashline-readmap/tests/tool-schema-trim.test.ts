/* biome-ignore-all lint/suspicious/noExplicitAny: registered tool definitions are dynamic. */
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import init from "../index.js";

function registered() {
  const tools: Record<string, any> = {};
  init({
    registerTool(def: any) {
      tools[def.name] = def;
    },
    on() {},
    events: { emit() {}, on() {} },
  } as any);
  return tools;
}

const validate = (tool: any, args: unknown) =>
  validateToolArguments(tool, {
    type: "toolCall",
    id: "c",
    name: tool.name,
    arguments: args,
  } as any);

afterEach(() => {
  delete (globalThis as any).__hashlineToolExecutors;
});

// The model-facing surface trimmed from 1,050 sessions of usage (sbdpi-rnw).
describe("trimmed tool schemas", () => {
  it("does not offer ast_search to the model but keeps it for programmatic callers", () => {
    const tools = registered();
    expect(tools.ast_search).toBeUndefined();
    expect((globalThis as any).__hashlineToolExecutors.ast_search).toBeDefined();
  });

  it("offers only the used parameters", () => {
    const tools = registered();
    const props = (name: string) => Object.keys(tools[name].parameters.properties).sort();
    expect(props("find")).toEqual([
      "limit",
      "maxDepth",
      "path",
      "pattern",
      "reverse",
      "sortBy",
      "type",
    ]);
    expect(props("grep")).toEqual([
      "context",
      "glob",
      "ignoreCase",
      "limit",
      "literal",
      "path",
      "pattern",
      "summary",
    ]);
    expect(props("write")).toEqual(["content", "path"]);
    expect(props("edit")).toEqual(["edits", "path", "postEditVerify"]);
    const variants = tools.edit.parameters.properties.edits.items.anyOf.map((b: any) =>
      Object.keys(b.properties).join(","),
    );
    expect(variants).toEqual(["set_line", "replace_lines", "insert_after", "replace"]);
    const schema = JSON.stringify(tools.edit.parameters);
    expect(schema).not.toContain("additionalProperties");
    expect(schema).not.toContain("fuzzy");
  });

  it("still lets Pi accept extra keys the model adds, without additionalProperties", () => {
    const tools = registered();
    expect(() =>
      validate(tools.edit, {
        path: "a.ts",
        note: "extra top-level key",
        edits: [{ set_line: { anchor: "1:abc", new_text: "x", why: "extra" }, junk: 1 }],
      }),
    ).not.toThrow();
  });

  it("rejects the variants no longer offered", () => {
    const tools = registered();
    for (const item of [
      { replace_symbol: { symbol: "a", new_body: "b" } },
      { old_text: "a", new_text: "b" },
      { insert_after: { anchor: "1:abc", text: "x" } },
    ]) {
      expect(() => validate(tools.edit, { path: "a.ts", edits: [item] })).toThrow(
        /Validation failed/,
      );
    }
  });
});
