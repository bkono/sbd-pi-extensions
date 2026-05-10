#!/usr/bin/env node
import {
  E2eHarness,
  loadRuntimeModules,
  packageDefaultExecutionMode,
  resolveExecutionMode,
  runScenario,
} from "./lib/current-branch-e2e-harness.mjs";

const { bw, constants, orchestrator, registry } = await loadRuntimeModules();
const { createBeadworkAdapter } = bw;
const { DEFAULT_CONFIG } = constants;
const { inspectWorkerRuntime, runBoundedEpicLoop } = orchestrator;
const { loadWorkerRegistry, resolveWorkerRegistryPath, upsertWorkerRuntime } = registry;
runScenario(async () => {
  const h = new E2eHarness({
    scenario: "current-branch-delegate",
    artifactGroup: "e2e-current-branch-delegate",
  });
  await h.init();
  await h.initGitRepo();
  await h.initBeadwork("e2ecbd");

  await h.step("resolve current-branch from package default without mode override");
  const defaultMode = await packageDefaultExecutionMode();
  const fakeWorkerCommand = await h.installFakeWorkerCommand();
  const config = {
    ...DEFAULT_CONFIG,
    tmux: { ...DEFAULT_CONFIG.tmux, workerCommand: fakeWorkerCommand },
    workerExecution: {
      ...DEFAULT_CONFIG.workerExecution,
      mode: "current-branch",
      review: { enabled: false },
    },
    landing: {
      ...DEFAULT_CONFIG.landing,
      validateCommands: [],
      review: { ...DEFAULT_CONFIG.landing.review, enabled: false },
    },
  };
  const resolved = resolveExecutionMode({ env: {}, config: {}, defaultMode });
  h.assert(
    resolved.mode === "current-branch" && resolved.source === "default",
    "delegate did not resolve current-branch mode from default",
    { defaultMode, resolved },
  );
  h.assert(defaultMode === "current-branch", "package default is not current-branch", {
    defaultMode,
  });
  await h.writeArtifact("default-mode-resolution.json", { defaultMode, resolved });
  await h.writeArtifact("orchestrator-config.json", {
    workerExecution: config.workerExecution,
    landing: config.landing,
    tmux: { ...config.tmux, workerCommand: "<artifact fake-worker.mjs>" },
  });
  h.cover("11-default-flip-readiness");

  const epicId = await h.bwCreate("delegate current-branch epic", {
    type: "epic",
    description: "parent epic for direct runBoundedEpicLoop smoke coverage",
  });
  const ticketId = await h.bwCreate("delegate current-branch fixture", {
    description: "fake worker must write src/current-branch-orchestrated-result.txt and close",
    parent: epicId,
  });
  await h.snapshotBwCli("before-delegate", [epicId, ticketId]);
  await h.snapshotGit("before-delegate");

  await h.step("run bounded epic loop with scripted tmux backend", { epicId, ticketId });
  const adapter = createBeadworkAdapter();
  const registryPath = resolveWorkerRegistryPath(h.repoDir, config.storage.workerRegistryFile);
  const tmuxBackend = h.scriptedTmuxBackend();
  const summary = await runBoundedEpicLoop({
    cwd: h.repoDir,
    repoRoot: h.repoDir,
    config,
    adapter,
    epicId,
    options: {
      workers: 1,
      until: "blocked",
      dryRun: false,
      maxCycles: 1,
      pollIntervalMs: 0,
      noSpawn: false,
    },
    tmuxBackend,
    runner: h.processRunner("delegate-orchestrator"),
  });
  await h.writeArtifact("run-summary.json", summary);
  h.assert(summary.launched.includes(ticketId), "run loop did not launch delegate ticket", summary);

  const launchedWorkers = await loadWorkerRegistry(registryPath);
  const launchedWorker = launchedWorkers.find((worker) => worker.ticketId === ticketId);
  h.assert(Boolean(launchedWorker), "orchestrator did not persist launched worker", {
    launchedWorkers,
  });
  h.assert(launchedWorker.executionMode === "current-branch", "worker was not current-branch", {
    launchedWorker,
  });
  h.assert(launchedWorker.checkoutPath === h.repoDir, "worker did not launch in repo root", {
    launchedWorker,
    repoDir: h.repoDir,
  });
  h.assert(!("worktreePath" in launchedWorker), "current-branch worker has worktreePath", {
    launchedWorker,
  });
  await h.snapshotRegistry("after-orchestrator-launch", { workers: launchedWorkers });

  await h.step("poll launched worker runtime state", {
    workerId: launchedWorker.workerId,
  });
  const completedWorker = await inspectWorkerRuntime({
    cwd: h.repoDir,
    repoRoot: h.repoDir,
    worker: launchedWorker,
    adapter,
    tmuxBackend,
    runner: h.processRunner("delegate-runtime-poll"),
  });
  await upsertWorkerRuntime(registryPath, completedWorker);
  h.assert(completedWorker.status === "exited", "runtime poll did not observe worker exit", {
    completedWorker,
  });

  await h.step("inspect launched worker through current-branch verification", {
    workerId: completedWorker.workerId,
  });
  const lifecycleEvents = [];
  const verifiedWorker = await inspectWorkerRuntime({
    cwd: h.repoDir,
    repoRoot: h.repoDir,
    worker: completedWorker,
    adapter,
    config,
    tmuxBackend,
    runner: h.processRunner("delegate-inspect"),
    awaitOrchestration: true,
    onLifecycleEvent: (event) => lifecycleEvents.push(event),
    onWorkerUpdate: async (nextWorker) => {
      await upsertWorkerRuntime(registryPath, nextWorker);
    },
  });
  await upsertWorkerRuntime(registryPath, verifiedWorker);
  await h.writeArtifact("lifecycle-events.json", lifecycleEvents);
  await h.snapshotRegistry("after-verify", { workers: await loadWorkerRegistry(registryPath) });
  await h.snapshotBwCli("after-verify", [epicId, ticketId]);
  await h.snapshotGit("after-verify");

  const log = await h.command("delegate-attribution-log", h.repoDir, "git", [
    "log",
    "--format=%H %s%n%b",
    "-5",
  ]);
  h.assert(log.stdout.includes(ticketId), "ticket id missing from delegate commit", {
    ticketId,
    log: log.stdout,
  });
  await h.validation("delegate-npm-test", h.repoDir, "npm", ["run", "test"]);
  h.assert(verifiedWorker.status === "verified", "delegate worker did not verify", verifiedWorker);
  h.assert(
    verifiedWorker.landingVerification?.includes("Current-branch worker verified"),
    "current-branch verification path did not run",
    verifiedWorker,
  );
  h.cover("1-current-branch-delegate");
  h.cover("4-commit-attribution");

  await h.writeArtifact("scenario-result.json", {
    defaultMode,
    resolvedMode: resolved,
    epicId,
    ticketId,
    summary,
    worker: verifiedWorker,
    lifecycleEvents,
  });
  return h;
});
