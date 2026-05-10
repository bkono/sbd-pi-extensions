#!/usr/bin/env node
import {
  E2eHarness,
  loadRuntimeModules,
  packageDefaultExecutionMode,
  resolveExecutionMode,
  runScenario,
  stableJson,
} from "./lib/current-branch-e2e-harness.mjs";

const { bw, constants, orchestrator, registry } = await loadRuntimeModules();
const { createBeadworkAdapter } = bw;
const { DEFAULT_CONFIG } = constants;
const { inspectWorkerRuntime, launchTicketWorker } = orchestrator;
const { loadWorkerRegistry, resolveWorkerRegistryPath, upsertWorkerRuntime } = registry;
runScenario(async () => {
  const h = new E2eHarness({
    scenario: "worktree-preservation",
    artifactGroup: "e2e-worktree-preservation",
  });
  await h.init();
  await h.initGitRepo();
  await h.initBeadwork("e2ewtp");

  await h.step("configure explicit worktree worker mode");
  const defaultMode = await packageDefaultExecutionMode();
  const fakeWorkerCommand = await h.installFakeWorkerCommand();
  const config = {
    ...DEFAULT_CONFIG,
    tmux: { ...DEFAULT_CONFIG.tmux, workerCommand: fakeWorkerCommand },
    landing: {
      ...DEFAULT_CONFIG.landing,
      policy: "auto",
      validateCommands: ["npm run test"],
      review: { ...DEFAULT_CONFIG.landing.review, enabled: false },
    },
    workerExecution: { ...DEFAULT_CONFIG.workerExecution, mode: "worktree" },
    worktrees: { ...DEFAULT_CONFIG.worktrees, cleanup: "keep" },
  };
  await h.writeRepoFile(
    ".pi/beadwork-config.json",
    stableJson({
      landing: config.landing,
      workerExecution: config.workerExecution,
      worktrees: config.worktrees,
    }),
  );
  const resolved = resolveExecutionMode({ env: {}, config, defaultMode });
  h.assert(resolved.mode === "worktree", "worktree override did not resolve worktree mode", {
    resolved,
  });
  h.cover("8-worktree-preservation");
  h.cover("10-config-overrides");

  const ticketId = await h.bwCreate("worktree preservation fixture", {
    description: "worker must run outside repository root and land through orchestrator helper",
  });
  await h.snapshotBwCli("before-worktree", [ticketId]);
  await h.snapshotGit("before-worktree");

  await h.step("launch real worktree worker through orchestrator", { ticketId });
  const adapter = createBeadworkAdapter();
  const registryPath = resolveWorkerRegistryPath(h.repoDir, config.storage.workerRegistryFile);
  const tmuxBackend = h.scriptedTmuxBackend();
  const worker = await launchTicketWorker({
    cwd: h.repoDir,
    repoRoot: h.repoDir,
    config,
    adapter,
    ticketId,
    tmuxBackend,
    processRunner: h.processRunner("worktree-launch"),
  });
  h.assert(worker.executionMode === "worktree", "worker did not launch in worktree mode", worker);
  h.assert(worker.worktreePath && worker.worktreePath !== h.repoDir, "worktree path not isolated", {
    worker,
    repoDir: h.repoDir,
  });
  await h.snapshotRegistry("after-launch", { workers: await loadWorkerRegistry(registryPath) });

  await h.step("inspect completed worktree worker and land through helper", {
    workerId: worker.workerId,
    worktreePath: worker.worktreePath,
  });
  const lifecycleEvents = [];
  const landedWorker = await inspectWorkerRuntime({
    cwd: h.repoDir,
    repoRoot: h.repoDir,
    worker,
    adapter,
    config,
    tmuxBackend,
    runner: h.processRunner("worktree-inspect"),
    awaitOrchestration: true,
    onLifecycleEvent: (event) => lifecycleEvents.push(event),
    onWorkerUpdate: async (nextWorker) => {
      await upsertWorkerRuntime(registryPath, nextWorker);
    },
  });
  await upsertWorkerRuntime(registryPath, landedWorker);
  await h.writeArtifact("lifecycle-events.json", lifecycleEvents);
  await h.snapshotRegistry("after-landing", { workers: await loadWorkerRegistry(registryPath) });
  await h.snapshotBwCli("after-landing", [ticketId]);
  await h.snapshotGit("after-landing");

  const worktreeList = await h.command("git-worktree-list", h.repoDir, "git", ["worktree", "list"]);
  const log = await h.command("git-log-after-landing", h.repoDir, "git", [
    "log",
    "--oneline",
    "--decorate",
    "-5",
  ]);
  const usedFastForwardLanding = h.commands.some(
    (record) =>
      record.command === "git" &&
      Array.isArray(record.args) &&
      record.args[0] === "merge" &&
      record.args[1] === "--ff-only",
  );

  h.assert(worktreeList.stdout.includes(worker.worktreePath), "linked worktree was not created", {
    worktreePath: worker.worktreePath,
    worktreeList: worktreeList.stdout,
  });
  h.assert(log.stdout.includes(ticketId), "landed commit not visible on main history", {
    ticketId,
    log: log.stdout,
  });
  h.assert(usedFastForwardLanding, "worktree landing helper did not run git merge --ff-only", {
    commands: h.commands.map((record) => ({ command: record.command, args: record.args })),
  });
  h.assert(landedWorker.status === "landed", "worktree worker did not reach landed", {
    landedWorker,
  });
  h.assert(landedWorker.validationStatus === "passed", "worktree validation did not pass", {
    landedWorker,
  });
  h.assert(
    landedWorker.landingVerification?.includes("Landing verified"),
    "worktree landing verification path did not complete",
    { landedWorker },
  );

  await h.writeArtifact("scenario-result.json", {
    defaultMode,
    resolved,
    ticketId,
    worker: landedWorker,
    worktreeList: worktreeList.stdout,
    lifecycleEvents,
  });
  return h;
});
