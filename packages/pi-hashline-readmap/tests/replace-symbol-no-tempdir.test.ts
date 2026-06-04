import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerEditTool } from "../src/edit.js";

function makeFakePi() {
  const tools: any[] = [];
  return { pi: { registerTool: (t: any) => tools.push(t) } as any, tools };
}

describe("replaceSymbol does not create temp directories (AC 5a)", () => {
  it("no rs-* directory is created under os.tmpdir() during a replace_symbol edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edit-rs-notmp-"));
    const fp = join(dir, "x.ts");
    writeFileSync(fp, `export function add() { return 1; }\n`);

    const { pi, tools } = makeFakePi();
    registerEditTool(pi, { wasReadInSession: () => true });
    const tool = tools[0];

    // Snapshot all entries in tmpdir before the call.
    const td = tmpdir();
    const before = new Set(readdirSync(td));

    await tool.execute(
      "c",
      {
        path: fp,
        edits: [
          { replace_symbol: { symbol: "add", new_body: "export function add() { return 2; }" } },
        ],
      },
      undefined,
      undefined,
      { cwd: dir },
    );

    // Any new entries in tmpdir that start with "rs-" indicate a leaked temp dir.
    const after = readdirSync(td);
    const newRsDirs = after.filter((d) => !before.has(d) && d.startsWith("rs-"));
    expect(newRsDirs).toHaveLength(0);
  });
});
