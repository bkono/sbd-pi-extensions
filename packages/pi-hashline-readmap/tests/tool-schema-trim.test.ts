/* biome-ignore-all lint/suspicious/noExplicitAny: registered tool definitions are dynamic. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("never tells the model that write returns anchors", () => {
    const tools = registered();
    const modelFacing = Object.values(tools)
      .flatMap((t: any) => [t.description, t.promptSnippet, ...(t.promptGuidelines ?? [])])
      .join("\n");
    expect(modelFacing).not.toMatch(/write[^\n]*anchor|anchors? from [^\n]*write/i);
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

  it("treats null and string booleans in programmatic-only fields as absent or false", async () => {
    const tools = registered();
    const dir = mkdtempSync(join(tmpdir(), "trim-coerce-"));
    try {
      writeFileSync(join(dir, "a.ts"), "const  x = 1;\n");
      const run = (name: string, args: Record<string, unknown>) =>
        tools[name].execute(
          name,
          validate(tools[name], args),
          new AbortController().signal,
          () => {},
          {
            cwd: dir,
          },
        );
      const find = await run("find", {
        pattern: "*.ts",
        regex: "false",
        modifiedSince: null,
        minSize: null,
        maxSize: null,
      });
      expect(find.isError).not.toBe(true);
      expect(find.content[0].text).toContain("a.ts");
      const grep = await run("grep", { pattern: "x", path: dir, scope: null, scopeContext: null });
      expect(grep.isError).not.toBe(true);
      await run("read", { path: join(dir, "a.ts") });
      const edit = await run("edit", {
        path: join(dir, "a.ts"),
        edits: [
          { replace: { old_text: "const x = 1;", new_text: "const x = 2;", fuzzy: "false" } },
        ],
      });
      expect(edit.details.ptcValue.error.code).toBe("text-not-found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
