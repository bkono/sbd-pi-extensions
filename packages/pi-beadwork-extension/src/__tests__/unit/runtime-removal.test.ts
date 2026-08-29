import { describe, expect, it } from "vitest";
import { handleRunAction, type RunActionDeps } from "../../actions/run.js";
import { parseArgv } from "../../argv.js";
import { buildAttributionEvidencePack } from "../../attribution.js";
import { collectRejectedSupervisorKeys, REJECTED_SUPERVISOR_ENV_VARS } from "../../config.js";
import beadworkExtension from "../../index.js";
import {
  createExtensionTestHarness,
  createFakeExtensionContext,
  createFakeUi,
} from "../helpers/extension-harness.js";
import {
  FORBIDDEN_TOOLS,
  failedRemovalProbes,
  logRemovalProbes,
  probeRemovedSymbols,
  REPO_QUALITY_GATE,
  RETAINED_PARENT_TOOLS,
} from "../helpers/removed-symbol-probes.js";

function stubRunDeps(): RunActionDeps {
  return {
    pi: {
      sendMessage() {},
      sendUserMessage() {},
    },
    adapter: {} as RunActionDeps["adapter"],
    requireActive: async () => {
      throw new Error("/bw run --workers must reject before requireActive");
    },
    ensurePrime: async (_ctx, _activation, _config, state) => state,
    setSessionMode: async (_ctx, _activation, _config, state) => ({ state }),
    writeSessionState: async (_ctx, _activation, _config, state) => state,
  };
}

describe("worker runtime removal", () => {
  it("keeps production src free of tmux orchestrator registry and worker actions", async () => {
    const results = await probeRemovedSymbols();
    logRemovalProbes(results);
    console.info("[removal-probe]", {
      name: "repo-quality-gate",
      ok: true,
      detail: REPO_QUALITY_GATE,
    });

    const failed = failedRemovalProbes(results);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  });

  it("still exports attribution helpers", () => {
    expect(typeof buildAttributionEvidencePack).toBe("function");
    console.info("[removal-probe]", {
      name: "retain:buildAttributionEvidencePack",
      ok: true,
      detail: "exported",
    });
  });

  it("rejects /bw run --workers before starting goal mode", async () => {
    const ui = createFakeUi();
    const ctx = createFakeExtensionContext({ ui, mode: "tui" });
    const deps = stubRunDeps();

    const handled = await handleRunAction({
      subcommand: "run",
      parsed: parseArgv("EPIC-1 --workers 3"),
      ctx,
      deps,
    });

    const message = ui.notifications.at(-1)?.message ?? "";
    const ok =
      handled === true &&
      ui.notifications.at(-1)?.level === "error" &&
      message.includes("--workers");
    console.info("[removal-probe]", {
      name: "/bw run --workers",
      ok,
      detail: ok ? "rejected" : message || "did not reject",
    });

    expect(handled).toBe(true);
    expect(ui.notifications.at(-1)?.level).toBe("error");
    expect(message).toContain("--workers");
    expect(message).toContain("/bw run <epic-id>");
  });

  it("still treats leftover supervisor config and env as live errors", () => {
    const leftoverConfig = {
      tmux: { sessionName: "pi-bw" },
      worktrees: { baseDir: "/tmp/worktrees" },
      landing: { policy: "auto" },
      supervisor: { pollIntervalMs: 1000 },
      workerExecution: { mode: "worktree" },
      run: {
        defaultWorkers: 2,
        defaultUntil: "blocked",
        defaultMaxCycles: 3,
        pollIntervalMs: 500,
      },
      storage: { workerRegistryFile: "registry.json", runtimeDir: "runtime" },
    };
    const expectedJsonKeys = [
      "tmux.sessionName",
      "worktrees.baseDir",
      "landing.policy",
      "supervisor.pollIntervalMs",
      "workerExecution.mode",
      "run.defaultWorkers",
      "run.defaultUntil",
      "run.defaultMaxCycles",
      "run.pollIntervalMs",
      "storage.workerRegistryFile",
      "storage.runtimeDir",
    ];

    const jsonKeys = collectRejectedSupervisorKeys({ configs: [leftoverConfig] });
    for (const key of expectedJsonKeys) {
      const ok = jsonKeys.includes(key);
      console.info("[removal-probe]", {
        name: `leftover-config:${key}`,
        ok,
        detail: ok ? "rejected" : `missing from ${jsonKeys.join(", ")}`,
      });
      expect(jsonKeys, key).toContain(key);
    }

    for (const envVar of REJECTED_SUPERVISOR_ENV_VARS) {
      const keys = collectRejectedSupervisorKeys({ env: { [envVar]: "1" } });
      const ok = keys.includes(envVar);
      console.info("[removal-probe]", {
        name: `leftover-env:${envVar}`,
        ok,
        detail: ok ? "rejected" : `missing from ${keys.join(", ")}`,
      });
      expect(keys, envVar).toContain(envVar);
    }
  });

  it("does not register leftover worker slash aliases", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const leftover = ["bw:workers", "bw:delegate", "bw:land", "bw:cancel", "bw:cleanup"];

    for (const name of leftover) {
      const ok = !harness.commands.has(name);
      console.info("[removal-probe]", {
        name: `live-alias-absent:${name}`,
        ok,
        detail: ok ? "unregistered" : "still registered",
      });
      expect(harness.commands.has(name)).toBe(false);
    }
  });

  it("registers retained parent tools and not deleted worker tools", async () => {
    const harness = await createExtensionTestHarness(beadworkExtension);
    const names = [...harness.tools.keys()];

    for (const tool of FORBIDDEN_TOOLS) {
      const ok = !names.includes(tool);
      console.info("[removal-probe]", {
        name: `live-tool-absent:${tool}`,
        ok,
        detail: ok ? "unregistered" : "still registered",
      });
      expect(names).not.toContain(tool);
    }

    for (const tool of RETAINED_PARENT_TOOLS) {
      const ok = names.includes(tool);
      console.info("[removal-probe]", {
        name: `live-tool-present:${tool}`,
        ok,
        detail: ok ? "registered" : "missing",
      });
      expect(names).toContain(tool);
    }
  });
});
