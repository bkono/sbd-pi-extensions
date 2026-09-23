// tests/read-symbol-at-line-java.test.ts

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerReadTool } from "../src/read.js";

function makeFakePi() {
  const tools: any[] = [];
  return { pi: { registerTool: (t: any) => tools.push(t) } as any, tools };
}

const JAVA_FIXTURE = `package x;
public class Foo {
  void bar() { System.out.println("a"); }
  void baz() {}
  void bar(int n) { System.out.println(n); }
}
`;

describe("read symbol with @line (Java)", () => {
  it('read symbol:"Foo.bar@3" resolves to the overload at line 3', async () => {
    const dir = mkdtempSync(join(tmpdir(), "read-java-"));
    const fp = join(dir, "Foo.java");
    writeFileSync(fp, JAVA_FIXTURE);
    const { pi, tools } = makeFakePi();
    registerReadTool(pi);
    const tool = tools[0];
    const res = await tool.execute("c", { path: fp, symbol: "Foo.bar@3" }, undefined, undefined, {
      cwd: dir,
    });
    expect(res.isError).toBeFalsy();
    const text = res.content?.[0]?.text ?? "";
    expect(text).toContain('System.out.println("a");');
    expect(text).not.toContain("System.out.println(n);");
  });

  it('read bundle:"local" with @line resolves the right overload and includes its lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), "read-java-bundle-"));
    const fp = join(dir, "Foo.java");
    writeFileSync(fp, JAVA_FIXTURE);
    const { pi, tools } = makeFakePi();
    registerReadTool(pi);
    const tool = tools[0];
    const res = await tool.execute(
      "c",
      { path: fp, symbol: "Foo.bar@5", bundle: "local" },
      undefined,
      undefined,
      { cwd: dir },
    );
    expect(res.isError).toBeFalsy();
    expect(res.details.ptcValue.bundle).toMatchObject({ mode: "local", applied: true });
    const text = res.content?.[0]?.text ?? "";
    expect(text).toContain("System.out.println(n);");
    const requested = res.details.ptcValue.lines.map((line: any) => line.raw).join("\n");
    expect(requested).toContain("System.out.println(n);");
    expect(requested).not.toContain('System.out.println("a");');
  });
});
