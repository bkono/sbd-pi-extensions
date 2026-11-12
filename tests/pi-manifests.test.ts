import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, matchesGlob, normalize, relative } from "node:path";
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

interface TsdownConfig {
  entry?: string | string[];
  outDir?: string;
}

/**
 * The files tsdown emits for a package, as Pi manifest paths. tsdown writes each entry to
 * `<outDir>/<path relative to the entries' common base dir>.mjs`: a `src`-only build mirrors
 * `src` (`dist/index.mjs`), a build with a package-root entry mirrors the package
 * (`dist/src/index.mjs`). Pi skips a missing target without an error, so the target must be
 * one of these outputs, not merely a published path.
 */
async function buildsTarget(packageDir: string, target: string): Promise<boolean> {
  const configPath = join(packageDir, "tsdown.config.ts");
  if (!existsSync(configPath)) return false;
  const loaded = (await import(configPath)).default as TsdownConfig | TsdownConfig[];
  const configs = Array.isArray(loaded) ? loaded : [loaded];
  const path = normalize(target).replace(/^\.\//, "");
  return configs.some((config) => {
    const entries = [config.entry ?? []].flat();
    const include = entries.filter((entry) => !entry.startsWith("!"));
    const exclude = entries.filter((entry) => entry.startsWith("!")).map((e) => e.slice(1));
    if (include.length === 0) return false;
    const staticDir = (entry: string) =>
      /[*?[{]/.test(entry)
        ? entry.slice(0, entry.search(/[*?[{]/)).replace(/\/?[^/]*$/, "")
        : dirname(entry);
    const dirs = include.map((entry) => normalize(staticDir(entry) || "."));
    const base = dirs.reduce((common, dir) => {
      let candidate = common;
      while (candidate !== "." && relative(candidate, dir).startsWith(".."))
        candidate = dirname(candidate);
      return candidate;
    });
    const outDir = normalize(config.outDir ?? "dist");
    const match = new RegExp(`^${outDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(.+)\\.mjs$`).exec(
      path,
    );
    if (!match) return false;
    const source = normalize(join(base, `${match[1]}.ts`));
    if (!existsSync(join(packageDir, source))) return false;
    const included = include.some(
      (entry) => normalize(entry) === source || matchesGlob(source, entry),
    );
    return included && !exclude.some((entry) => matchesGlob(source, entry));
  });
}

/**
 * A target is either a tsdown output or a package-root shim that only re-exports the
 * default of one (`export { default } from "./dist/index.mjs";`). The shim exists so the
 * installed path names the package in `pi config`.
 */
async function loadsBuildOutput(packageDir: string, target: string): Promise<boolean> {
  if (await buildsTarget(packageDir, target)) return true;
  const file = join(packageDir, target);
  if (!existsSync(file)) return false;
  const code = readFileSync(file, "utf8")
    .replace(/\/\/.*$/gm, "")
    .trim();
  const shim = /^export \{ default \} from "(\.\/[^"]+)";$/.exec(code);
  if (!shim) return false;
  const spec = normalize(join(dirname(normalize(target)), shim[1]!));
  return buildsTarget(packageDir, spec);
}

/** Pi's `pi config` label for an extension: `<parent folder>/<file>` (config-selector.js). */
function piConfigLabel(path: string): string {
  const parts = normalize(path).split("/");
  const file = parts.at(-1)!;
  const parent = parts.at(-2) ?? "";
  return parent === "extensions" ? file : `${parent}/${file}`;
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

    it(`${manifest.name} points pi.extensions at a tsdown build output`, async () => {
      const unbuilt: string[] = [];
      for (const target of manifest.pi?.extensions ?? []) {
        if (!(await loadsBuildOutput(join(packagesDir, dir), target))) unbuilt.push(target);
      }
      expect({ package: dir, unbuilt }).toEqual({ package: dir, unbuilt: [] });
    });
  }

  it("gives every npm-installed extension a distinct pi config label", () => {
    // Installed at node_modules/@scope/<name>/<target>.
    const labels = packages.flatMap(({ manifest }) =>
      (manifest.pi?.extensions ?? []).map((target) =>
        piConfigLabel(join("node_modules", manifest.name, target)),
      ),
    );
    const duplicates = labels.filter((label, i) => labels.indexOf(label) !== i);
    expect({ labels, duplicates }).toEqual({ labels, duplicates: [] });
  });

  it("root manifest points at files that exist in the checkout", () => {
    const rootManifest = read(join(root, "package.json"));
    const missing = (rootManifest.pi?.extensions ?? []).filter(
      (target) => !existsSync(join(root, target)),
    );
    expect(rootManifest.pi?.extensions?.length ?? 0).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
