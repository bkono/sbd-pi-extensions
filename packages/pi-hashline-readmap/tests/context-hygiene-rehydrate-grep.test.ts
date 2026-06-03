import { describe, expect, it } from "vitest";
import { buildGrepRehydrateDescriptor } from "../src/context-hygiene.js";

describe("grep rehydrate descriptors", () => {
  it("preserves safe grep inputs deterministically and omits undefined defaults", () => {
    expect(
      buildGrepRehydrateDescriptor({
        pattern: "TODO",
        literal: false,
        ignoreCase: false,
        summary: false,
        context: undefined,
        scopeContext: undefined,
      }),
    ).toEqual({
      tool: "grep",
      input: { pattern: "TODO" },
    });

    const descriptor = buildGrepRehydrateDescriptor({
      pattern: "createDemoDirectory",
      path: "tests/fixtures",
      glob: "**/*.ts",
      literal: true,
      ignoreCase: true,
      context: 0,
      summary: true,
      scope: "symbol",
      scopeContext: 2,
      limit: 100,
      signal: new AbortController().signal,
      cwd: { value: process.cwd() },
      renderedOutput: "rendered grep output",
    } as any);

    expect(descriptor).toEqual({
      tool: "grep",
      input: {
        pattern: "createDemoDirectory",
        path: "tests/fixtures",
        glob: "**/*.ts",
        literal: true,
        ignoreCase: true,
        context: 0,
        summary: true,
        scope: "symbol",
        scopeContext: 2,
      },
    });
    expect(
      buildGrepRehydrateDescriptor({
        pattern: "createDemoDirectory",
        path: "tests/fixtures",
        glob: "**/*.ts",
        literal: true,
        ignoreCase: true,
        context: 0,
        summary: true,
        scope: "symbol",
        scopeContext: 2,
      }),
    ).toEqual(descriptor);
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
    expect((descriptor.input as any).limit).toBeUndefined();
    expect((descriptor.input as any).signal).toBeUndefined();
    expect((descriptor.input as any).cwd).toBeUndefined();
    expect((descriptor.input as any).renderedOutput).toBeUndefined();
  });
});
