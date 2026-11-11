#!/usr/bin/env node
// Verifies vendored prompt text in src/upstream matches @mastra/memory sources.
// Usage: node scripts/upstream-diff.mjs <path-to-mastra observational-memory src dir>
// Every template literal of 200+ characters in src/upstream/prompts.ts must appear
// verbatim in the upstream observer-agent.ts, reflector-agent.ts, constants.ts, built-in-extractors.ts or extractor.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const upstreamDir = process.argv[2];
if (!upstreamDir) {
  console.error("usage: upstream-diff.mjs <mastra src/processors/observational-memory>");
  process.exit(2);
}
const upstream = [
  "observer-agent.ts",
  "reflector-agent.ts",
  "constants.ts",
  "built-in-extractors.ts",
  "extractor.ts",
]
  .map((file) => readFileSync(join(upstreamDir, file), "utf8"))
  .join("\n");
const vendored = readFileSync(new URL("../src/upstream/prompts.ts", import.meta.url), "utf8");

// Split template literals on `${...}` so interpolations do not count as drift.
const literals = [...vendored.matchAll(/`([^`]*)`/g)].flatMap((m) => m[1].split(/\$\{[^}]*\}/));
const long = literals.filter((text) => text.length >= 200);
const missing = long.filter((text) => !upstream.includes(text));
for (const text of missing) console.error(`drift: ${JSON.stringify(text.slice(0, 120))}…`);
console.log(
  `${long.length - missing.length}/${long.length} vendored prompt segments match upstream`,
);
process.exit(missing.length === 0 ? 0 : 1);
