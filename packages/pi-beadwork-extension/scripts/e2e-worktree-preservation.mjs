#!/usr/bin/env node
import path from "node:path";
import {
  E2eHarness,
  packageDefaultExecutionMode,
  resolveExecutionMode,
  runScenario,
  stableJson,
} from "./lib/current-branch-e2e-harness.mjs";

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
  const config = {
    landing: { policy: "auto" },
    workerExecution: { mode: "worktree" },
    worktrees: { cleanup: "keep" },
  };
  await h.writeRepoFile(".pi/beadwork-config.json", stableJson(config));
  const resolved = resolveExecutionMode({ env: {}, config, defaultMode });
  h.assert(resolved.mode === "worktree", "worktree override did not resolve worktree mode", {
    resolved,
  });
  h.cover("8-worktree-preservation");
  h.cover("10-config-overrides");

  const ticketId = await h.bwCreate("worktree preservation fixture", {
    description: "worker must run outside repository root and land through merge",
  });
  await h.snapshotBwCli("before-worktree", [ticketId]);
  await h.snapshotGit("before-worktree");
  const registry = { workers: [] };
  await h.snapshotRegistry("before-launch", registry);

  await h.step("create linked worktree for worker");
  const worktreePath = path.join(h.tempRoot, "worker-checkout");
  const branchName = `worker/${ticketId}`;
  await h.command("git-worktree-add", h.repoDir, "git", [
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
  ]);
  const worker = {
    id: "worker-worktree-1",
    ticketId,
    mode: resolved.mode,
    checkoutPath: worktreePath,
    branchName,
    status: "running",
    commits: [],
  };
  registry.workers.push(worker);
  await h.writePrompt(
    "worker-handoff-worktree",
    `# Worker handoff\n\nTicket: ${ticketId}\nMode: worktree\nCheckout: ${worktreePath}\nBranch: ${branchName}`,
  );
  await h.bw("worktree-start", ["start", ticketId]);
  await h.fakeCommand("worker", "worktree-launch", { ticketId, worktreePath, branchName });
  await h.snapshotRegistry("after-launch", registry);

  await h.step("worker commits in linked worktree");
  await h.writeRepoFile("src/worktree-result.txt", `landed through ${branchName}\n`, worktreePath);
  const commit = await h.gitCommit(
    ticketId,
    ["src/worktree-result.txt"],
    "feat: worktree preservation result",
    worktreePath,
  );
  worker.commits.push(commit);
  worker.status = "validated";
  await h.bw("worktree-comment", ["comment", ticketId, `Worktree worker committed ${commit}.`]);
  await h.bw("worktree-close", ["close", ticketId]);
  await h.validation("worktree-npm-test", worktreePath, "npm", ["run", "test"]);

  await h.step("land worktree branch back to current branch");
  await h.writePrompt(
    "worktree-landing-review",
    `# Worktree landing\n\nTicket: ${ticketId}\nBranch: ${branchName}\nCommit: ${commit}\nExpected landing: merge to main`,
  );
  await h.fakeCommand("reviewer", "worktree-landing-review", {
    ticketId,
    branchName,
    commit,
  });
  await h.fakeCommand("coordinator", "worktree-landing", {
    ticketId,
    branchName,
    expected: "landed",
  });
  await h.command("git-merge-worktree-branch", h.repoDir, "git", ["merge", "--no-ff", branchName]);
  worker.status = "landed";
  await h.snapshotRegistry("after-landing", registry);
  await h.snapshotBwCli("after-landing", [ticketId]);
  await h.snapshotGit("after-landing");

  const worktreeList = await h.command("git-worktree-list", h.repoDir, "git", ["worktree", "list"]);
  const log = await h.command("git-log-after-landing", h.repoDir, "git", [
    "log",
    "--oneline",
    "--decorate",
    "-5",
  ]);
  h.assert(worktreePath !== h.repoDir, "worktree worker used repository root", { worker });
  h.assert(worktreeList.stdout.includes(worktreePath), "linked worktree was not created", {
    worktreePath,
    worktreeList: worktreeList.stdout,
  });
  h.assert(log.stdout.includes(commit.slice(0, 7)), "landed commit not visible on main history", {
    commit,
    log: log.stdout,
  });
  h.assert(worker.status === "landed", "worktree worker did not reach landed", { worker });

  await h.writeArtifact("scenario-result.json", {
    defaultMode,
    resolved,
    ticketId,
    worker,
    worktreeList: worktreeList.stdout,
  });
  return h;
});
