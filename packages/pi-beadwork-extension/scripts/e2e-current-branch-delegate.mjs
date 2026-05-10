#!/usr/bin/env node
import {
  E2eHarness,
  packageDefaultExecutionMode,
  resolveExecutionMode,
  runScenario,
  stableJson,
} from "./lib/current-branch-e2e-harness.mjs";

runScenario(async () => {
  const h = new E2eHarness({
    scenario: "current-branch-delegate",
    artifactGroup: "e2e-current-branch-delegate",
  });
  await h.init();
  await h.initGitRepo();
  await h.initBeadwork("e2ecbd");

  await h.step("configure explicit current-branch worker mode");
  const defaultMode = await packageDefaultExecutionMode();
  const config = { workerExecution: { mode: "current-branch" } };
  await h.writeRepoFile(".pi/beadwork-config.json", stableJson(config));
  const resolved = resolveExecutionMode({ env: {}, config, defaultMode });
  h.assert(resolved.mode === "current-branch", "delegate did not resolve current-branch mode", {
    resolved,
  });
  h.cover("10-config-overrides");
  h.cover("11-default-flip-readiness");

  const ticketId = await h.bwCreate("delegate current-branch fixture", {
    description: "worker must write src/delegate-result.txt and close",
  });
  await h.snapshotBwCli("before-delegate", [ticketId]);
  const registry = { workers: [] };
  await h.snapshotRegistry("before-delegate", registry);
  await h.snapshotGit("before-delegate");

  await h.step("launch fake delegate worker in repository root", { ticketId });
  const launchHead = await h.command("delegate-launch-head", h.repoDir, "git", [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const worker = {
    id: "worker-delegate-1",
    ticketId,
    mode: resolved.mode,
    cwd: h.repoDir,
    launchHead: launchHead.stdout.trim(),
    status: "running",
    commits: [],
  };
  registry.workers.push(worker);
  await h.writePrompt(
    "worker-handoff-delegate",
    `# Worker handoff\n\nTicket: ${ticketId}\nMode: current-branch\nCheckout: ${h.repoDir}\nExpected files: src/delegate-result.txt`,
  );
  await h.bw("delegate-start", ["start", ticketId]);
  await h.fakeCommand("worker", "delegate-start", {
    ticketId,
    cwd: h.repoDir,
    mode: worker.mode,
  });
  await h.snapshotRegistry("after-launch", registry);

  await h.step("worker commits ticket-scoped change and closes ticket");
  await h.writeRepoFile("src/delegate-result.txt", `completed by ${ticketId}\n`);
  const commit = await h.gitCommit(
    ticketId,
    ["src/delegate-result.txt"],
    "feat: delegate worker result",
  );
  worker.commits.push(commit);
  worker.status = "closed";
  await h.bw("delegate-comment", [
    "comment",
    ticketId,
    `Implemented delegate result in ${commit}. Validation: npm run test passed.`,
  ]);
  await h.bw("delegate-close", ["close", ticketId]);
  await h.bw("sync", ["sync"], { allowFailure: true });

  await h.step("coordinator verifies worker output");
  await h.writePrompt(
    "coordinator-verification-delegate",
    `# Coordinator verification\n\nTicket: ${ticketId}\nCommit: ${commit}\nExpected file: src/delegate-result.txt`,
  );
  await h.fakeCommand("coordinator", "delegate-verification", {
    ticketId,
    commit,
    expectedFile: "src/delegate-result.txt",
  });
  const log = await h.command("delegate-attribution-log", h.repoDir, "git", [
    "log",
    "--format=%H %s%n%b",
    "-1",
  ]);
  h.assert(log.stdout.includes(ticketId), "ticket id missing from delegate commit", {
    ticketId,
    commit,
  });
  await h.validation("delegate-npm-test", h.repoDir, "npm", ["run", "test"]);
  worker.status = "verified";
  worker.verifiedAt = new Date().toISOString();
  await h.snapshotRegistry("after-verify", registry);
  await h.snapshotBwCli("after-verify", [ticketId]);
  await h.snapshotGit("after-verify");

  h.assert(worker.cwd === h.repoDir, "delegate worker did not run in repo root", worker);
  h.assert(worker.status === "verified", "delegate worker did not verify", worker);
  h.cover("1-current-branch-delegate");
  h.cover("4-commit-attribution");

  await h.writeArtifact("scenario-result.json", {
    defaultMode,
    resolvedMode: resolved,
    ticketId,
    worker,
    commit,
  });
  return h;
});
