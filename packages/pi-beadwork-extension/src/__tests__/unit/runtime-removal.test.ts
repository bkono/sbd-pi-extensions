import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAttributionEvidencePack } from "../../attribution.js";

const SRC_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

async function listProductionTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") {
        continue;
      }
      files.push(...(await listProductionTsFiles(fullPath)));
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("worker runtime removal", () => {
  it("keeps production src free of tmux orchestrator registry and worker actions", async () => {
    const files = await listProductionTsFiles(SRC_ROOT);
    const contents = await Promise.all(
      files.map(async (filePath) => ({
        filePath,
        source: await readFile(filePath, "utf8"),
      })),
    );

    const relative = (filePath: string) => path.relative(SRC_ROOT, filePath);
    const productionFiles = contents.map((entry) => relative(entry.filePath));

    expect(productionFiles).not.toContain("orchestrator.ts");
    expect(productionFiles).not.toContain("tmux.ts");
    expect(productionFiles).not.toContain("worktree.ts");
    expect(productionFiles).not.toContain("registry.ts");
    expect(productionFiles).not.toContain("worker-diagnostics.ts");
    expect(productionFiles).not.toContain(path.join("actions", "delegate.ts"));
    expect(productionFiles).not.toContain(path.join("actions", "landing.ts"));
    expect(productionFiles).not.toContain(path.join("actions", "workers.ts"));
    expect(productionFiles).toContain("attribution.ts");
    expect(productionFiles).toContain("index.ts");

    for (const { filePath, source } of contents) {
      const label = relative(filePath);
      expect(source, label).not.toMatch(/from ["']\.\/tmux\.js["']/);
      expect(source, label).not.toMatch(/from ["']\.\.\/tmux\.js["']/);
      expect(source, label).not.toContain("runBoundedEpicLoop");
      expect(source, label).not.toMatch(/from ["']\.\/orchestrator\.js["']/);
      expect(source, label).not.toMatch(/from ["']\.\.\/orchestrator\.js["']/);
      expect(source, label).not.toMatch(/from ["']\.\/actions\/delegate\.js["']/);
      expect(source, label).not.toMatch(/from ["']\.\/actions\/landing\.js["']/);
      expect(source, label).not.toMatch(/from ["']\.\/actions\/workers\.js["']/);
      expect(source, label).not.toContain("beadwork_delegate");
    }
  });

  it("still exports attribution helpers", () => {
    expect(typeof buildAttributionEvidencePack).toBe("function");
  });
});
