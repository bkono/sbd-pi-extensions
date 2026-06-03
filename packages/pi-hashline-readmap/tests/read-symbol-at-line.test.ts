import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { registerReadTool } from "../src/read.js";

function makeFakePi() {
  const tools: any[] = [];
  return { pi: { registerTool: (t: any) => tools.push(t) } as any, tools };
}

describe("read symbol with @line (TypeScript)", () => {
  it('read symbol:"Foo.bar@3" returns the overload starting at line 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), "read-symbol-ts-"));
    const fp = join(dir, "x.ts");
    writeFileSync(
      fp,
      `export class Foo {
  bar() {
    return 1;
  }
  baz() {}
  bar(n: number) {
    return n;
  }
}
`,
    );
    const { pi, tools } = makeFakePi();
    registerReadTool(pi);
    const tool = tools[0];
    const res = await tool.execute("c", { path: fp, symbol: "Foo.bar@3" }, undefined, undefined, {
      cwd: dir,
    });
    expect(res.isError).toBeFalsy();
    const text = res.content?.[0]?.text ?? "";
    expect(text).toContain("return 1");
    expect(text).not.toContain("return n");
  });
});
