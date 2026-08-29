/**
 * Cutover removal probes (sbdpi-vur.4.5).
 *
 * CI tripwire after worker-runtime deletion. Do not reintroduce shims, stub
 * modules, or wrapper façades to make these greps pass.
 *
 * Leftover supervisor config/env names remain live *rejection* APIs in
 * `config.ts` and are not treated as forbidden symbols.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SRC_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** Repo-wide gate for the published cutover. Package-scoped is not a substitute. */
export const REPO_QUALITY_GATE =
  "npm run lint && npm run test && npm run typecheck && npm run build";

export const FORBIDDEN_PRODUCTION_FILES = [
  "orchestrator.ts",
  "tmux.ts",
  "worktree.ts",
  "registry.ts",
  "worker-diagnostics.ts",
  path.join("actions", "delegate.ts"),
  path.join("actions", "landing.ts"),
  path.join("actions", "workers.ts"),
  path.join("tui", "worker-manager.ts"),
] as const;

export const FORBIDDEN_IMPORT_MODULES = [
  "tmux.js",
  "orchestrator.js",
  "worktree.js",
  "registry.js",
  "worker-diagnostics.js",
  "actions/delegate.js",
  "actions/landing.js",
  "actions/workers.js",
  "tui/worker-manager.js",
] as const;

export const FORBIDDEN_TOOLS = [
  "beadwork_delegate",
  "beadwork_worker_done",
  "beadwork_land_worker",
  "beadwork_worker_check",
] as const;

export const FORBIDDEN_ORCHESTRATION_SYMBOLS = [
  "minion_report_result",
  "minion_wait",
  "protocolStatus",
  "assignmentPermit",
  "beadwork_bind_attempt",
  "shouldStopAfterTurn",
  "runBoundedEpicLoop",
] as const;

/** Live minions runtime / second lifecycle channel. Tests may import these; production src must not. */
export const FORBIDDEN_MINIONS_RUNTIME_SYMBOLS = [
  "pi-minions",
  "AgentTree",
  "PathOverlapLog",
  "announcePathIntent",
  "minion-lifecycle",
  "LIFECYCLE_PACKET_CUSTOM_TYPE",
  "createLifecyclePacketDispatcher",
  "rejectWrite",
  "editAllowed: false",
] as const;

export const RETAINED_PRODUCTION_FILES = ["attribution.ts", "index.ts"] as const;

export const RETAINED_PARENT_TOOLS = [
  "beadwork_sync",
  "beadwork_show",
  "beadwork_list_issues",
  "beadwork_issue_history",
  "beadwork_ready",
  "beadwork_blocked",
  "beadwork_status",
  "beadwork_prime",
] as const;

export type ProductionSource = {
  relative: string;
  source: string;
};

export type RemovalProbeResult = {
  name: string;
  ok: boolean;
  detail: string;
};

export async function listProductionTsFiles(dir: string): Promise<string[]> {
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

export async function loadProductionSources(
  srcRoot: string = SRC_ROOT,
): Promise<ProductionSource[]> {
  const files = await listProductionTsFiles(srcRoot);
  return Promise.all(
    files.map(async (filePath) => ({
      relative: path.relative(srcRoot, filePath),
      source: await readFile(filePath, "utf8"),
    })),
  );
}

function substringHits(contents: ProductionSource[], needle: string): string[] {
  return contents.filter((entry) => entry.source.includes(needle)).map((entry) => entry.relative);
}

function importHits(contents: ProductionSource[], moduleFile: string): string[] {
  const escaped = moduleFile.replaceAll(".", "\\.");
  const pattern = new RegExp(`from ["'][^"']*${escaped}["']`);
  return contents.filter((entry) => pattern.test(entry.source)).map((entry) => entry.relative);
}

function formatHits(hits: string[]): string {
  return hits.length === 0 ? "no production hits" : `hits: ${hits.join(", ")}`;
}

function probe(name: string, ok: boolean, detail: string): RemovalProbeResult {
  return { name, ok, detail };
}

export async function probeRemovedSymbols(
  srcRoot: string = SRC_ROOT,
): Promise<RemovalProbeResult[]> {
  const contents = await loadProductionSources(srcRoot);
  const productionFiles = new Set(contents.map((entry) => entry.relative));
  const results: RemovalProbeResult[] = [];

  for (const relative of FORBIDDEN_PRODUCTION_FILES) {
    const present = productionFiles.has(relative);
    results.push(
      probe(`file:${relative}`, !present, present ? "present (must stay deleted)" : "absent"),
    );
  }

  for (const relative of RETAINED_PRODUCTION_FILES) {
    const present = productionFiles.has(relative);
    results.push(probe(`retain-file:${relative}`, present, present ? "present" : "missing"));
  }

  for (const moduleFile of FORBIDDEN_IMPORT_MODULES) {
    const hits = importHits(contents, moduleFile);
    results.push(probe(`import:${moduleFile}`, hits.length === 0, formatHits(hits)));
  }

  for (const tool of FORBIDDEN_TOOLS) {
    const hits = substringHits(contents, tool);
    results.push(probe(`tool:${tool}`, hits.length === 0, formatHits(hits)));
  }

  for (const symbol of FORBIDDEN_ORCHESTRATION_SYMBOLS) {
    const hits = substringHits(contents, symbol);
    results.push(probe(`orchestration:${symbol}`, hits.length === 0, formatHits(hits)));
  }

  for (const symbol of FORBIDDEN_MINIONS_RUNTIME_SYMBOLS) {
    const hits = substringHits(contents, symbol);
    results.push(probe(`minions-runtime:${symbol}`, hits.length === 0, formatHits(hits)));
  }

  const indexSource = contents.find((entry) => entry.relative === "index.ts")?.source ?? "";
  for (const tool of RETAINED_PARENT_TOOLS) {
    const registered = indexSource.includes(`name: "${tool}"`);
    results.push(
      probe(
        `retain-tool:${tool}`,
        registered,
        registered ? "registered in index.ts" : "missing name: registration in index.ts",
      ),
    );
  }

  return results;
}

export function logRemovalProbes(results: RemovalProbeResult[]): void {
  for (const result of results) {
    console.info("[removal-probe]", result);
  }
}

export function failedRemovalProbes(results: RemovalProbeResult[]): RemovalProbeResult[] {
  return results.filter((result) => !result.ok);
}
