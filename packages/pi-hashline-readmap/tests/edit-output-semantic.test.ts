import { beforeAll, describe, expect, it } from "vitest";
import { buildEditOutput } from "../src/edit-output.js";
import { ensureHashInit } from "../src/hashline.js";

describe("buildEditOutput semanticSummary", () => {
  beforeAll(async () => {
    await ensureHashInit();
  });
  it("includes semanticSummary in ptcValue when provided", () => {
    const result = buildEditOutput({
      path: "/tmp/test.ts",
      displayPath: "test.ts",
      diff: "+1 const x = 10;",
      firstChangedLine: 1,
      warnings: [],
      noopEdits: [],
      edits: [{ set_line: { anchor: "1:abc", new_text: "const x = 10;" } }],
      semanticSummary: {
        classification: "semantic",
        difftasticAvailable: true,
        movedBlocks: 0,
      },
    });

    expect(result.ptcValue.semanticSummary).toEqual({
      classification: "semantic",
      difftasticAvailable: true,
      movedBlocks: 0,
    });
  });
  it("omits semanticSummary from ptcValue when not provided", () => {
    const result = buildEditOutput({
      path: "/tmp/test.ts",
      displayPath: "test.ts",
      diff: "+1 const x = 10;",
      firstChangedLine: 1,
      warnings: [],
      noopEdits: [],
      edits: [{ set_line: { anchor: "1:abc", new_text: "const x = 10;" } }],
    });
    expect(result.ptcValue.semanticSummary).toBeUndefined();
  });
  it("preserves movedBlocks in ptcValue without changing the semanticSummary shape", () => {
    const result = buildEditOutput({
      path: "/tmp/test.ts",
      displayPath: "test.ts",
      diff: [
        "--- a/test.ts",
        "+++ b/test.ts",
        "@@ -1,2 +1,2 @@",
        "-const a = 1;",
        "-const b = 2;",
        "+const b = 2;",
        "+const a = 1;",
      ].join("\n"),
      firstChangedLine: 1,
      warnings: [],
      noopEdits: [],
      edits: [
        {
          replace_lines: {
            start_anchor: "1:abc",
            end_anchor: "2:def",
            new_text: "const b = 2;\nconst a = 1;",
          },
        },
      ],
      semanticSummary: {
        classification: "mixed",
        difftasticAvailable: true,
        movedBlocks: 2,
      },
    });

    expect(result.ptcValue.semanticSummary).toEqual({
      classification: "mixed",
      difftasticAvailable: true,
      movedBlocks: 2,
    });
  });
});
