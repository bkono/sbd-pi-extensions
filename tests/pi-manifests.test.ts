import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pi loads a package through its `pi.extensions` manifest. Installed from npm, only the
 * paths in `files` exist, so every manifest target must be published. The root manifest is
 * the local-checkout path (the user's Pi loads this repo directly) and must point at files
 * that exist in the tree.
 */
const root = join(import.meta.dirname, "..");
const packagesDir = join(root, "packages");

interface Manifest {
  name: string;
  private?: boolean;
  files?: string[];
  pi?: { extensions?: string[] };
}

function read(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function published(target: string, files: readonly string[]): boolean {
  const path = normalize(target).replace(/^\.\//, "");
  return files.some((entry) => {
    const prefix = normalize(entry).replace(/^\.\//, "").replace(/\/$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}

const packages = readdirSync(packagesDir)
  .filter((dir) => existsSync(join(packagesDir, dir, "package.json")))
  .map((dir) => ({ dir, manifest: read(join(packagesDir, dir, "package.json")) }))
  .filter(({ manifest }) => (manifest.pi?.extensions?.length ?? 0) > 0);

describe("Pi extension manifests", () => {
  it("covers every package that declares Pi extensions", () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  for (const { dir, manifest } of packages) {
    it(`${manifest.name} publishes every pi.extensions target`, () => {
      const unpublished = (manifest.pi?.extensions ?? []).filter(
        (target) => !published(target, manifest.files ?? []),
      );
      expect({ package: dir, unpublished }).toEqual({ package: dir, unpublished: [] });
    });
  }

  it("root manifest points at files that exist in the checkout", () => {
    const rootManifest = read(join(root, "package.json"));
    const missing = (rootManifest.pi?.extensions ?? []).filter(
      (target) => !existsSync(join(root, target)),
    );
    expect(rootManifest.pi?.extensions?.length ?? 0).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
