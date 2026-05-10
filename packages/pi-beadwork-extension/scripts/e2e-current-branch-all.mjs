#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const scripts = [
  "e2e-current-branch-delegate.mjs",
  "e2e-current-branch-swarm.mjs",
  "e2e-worktree-preservation.mjs",
];

for (const script of scripts) {
  console.log(`[e2e:current-branch-all] running ${script}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptsDir, script)], {
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${script} exited with ${code}`));
    });
  });
}

console.log("[e2e:current-branch-all] all deterministic smoke scripts passed");
