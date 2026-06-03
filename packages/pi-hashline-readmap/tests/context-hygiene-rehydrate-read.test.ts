import { describe, expect, it } from "vitest";
import { buildReadRehydrateDescriptor } from "../src/context-hygiene.js";

describe("read rehydrate descriptors", () => {
  it("preserves safe read inputs deterministically and omits undefined defaults", () => {
    expect(
      buildReadRehydrateDescriptor({
        path: "src/read.ts",
        offset: undefined,
        limit: undefined,
        map: false,
      }),
    ).toEqual({
      tool: "read",
      input: { path: "src/read.ts" },
    });

    const ranged = buildReadRehydrateDescriptor({
      path: "src/read.ts",
      offset: 10,
      limit: 5,
    });
    expect(ranged).toEqual({
      tool: "read",
      input: { path: "src/read.ts", offset: 10, limit: 5 },
    });
    expect(buildReadRehydrateDescriptor({ path: "src/read.ts", offset: 10, limit: 5 })).toEqual(
      ranged,
    );
    expect(JSON.parse(JSON.stringify(ranged))).toEqual(ranged);

    expect(
      buildReadRehydrateDescriptor({
        path: "src/read-output.ts",
        symbol: "buildReadOutput",
        bundle: "local",
      }),
    ).toEqual({
      tool: "read",
      input: { path: "src/read-output.ts", symbol: "buildReadOutput", bundle: "local" },
    });

    expect(
      buildReadRehydrateDescriptor({
        path: "src/read-output.ts",
        map: true,
        signal: new AbortController().signal,
        cwd: { value: process.cwd() },
        renderedOutput: "1:abc|content",
      } as any),
    ).toEqual({
      tool: "read",
      input: { path: "src/read-output.ts", map: true },
    });
  });
});
