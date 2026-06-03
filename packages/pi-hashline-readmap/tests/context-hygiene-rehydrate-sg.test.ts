import { describe, expect, it } from "vitest";
import { buildAstSearchRehydrateDescriptor } from "../src/context-hygiene.js";

describe("ast_search rehydrate descriptors", () => {
  it("preserves safe ast_search inputs deterministically and omits undefined defaults", () => {
    expect(
      buildAstSearchRehydrateDescriptor({
        pattern: "console.log($A)",
        lang: undefined,
        path: undefined,
      }),
    ).toEqual({
      tool: "ast_search",
      input: { pattern: "console.log($A)" },
    });

    const descriptor = buildAstSearchRehydrateDescriptor({
      pattern: "export function $NAME($$$ARGS) { $$$BODY }",
      lang: "typescript",
      path: "src",
      signal: new AbortController().signal,
      cwd: { value: process.cwd() },
      renderedOutput: "rendered ast_search output",
    } as any);

    expect(descriptor).toEqual({
      tool: "ast_search",
      input: {
        pattern: "export function $NAME($$$ARGS) { $$$BODY }",
        lang: "typescript",
        path: "src",
      },
    });
    expect(
      buildAstSearchRehydrateDescriptor({
        pattern: "export function $NAME($$$ARGS) { $$$BODY }",
        lang: "typescript",
        path: "src",
      }),
    ).toEqual(descriptor);
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
    expect((descriptor.input as any).signal).toBeUndefined();
    expect((descriptor.input as any).cwd).toBeUndefined();
    expect((descriptor.input as any).renderedOutput).toBeUndefined();
  });
});
