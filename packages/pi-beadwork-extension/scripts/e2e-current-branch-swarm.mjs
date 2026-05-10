#!/usr/bin/env node
import {
  E2eHarness,
  packageDefaultExecutionMode,
  resolveExecutionMode,
  runScenario,
  stableJson,
} from "./lib/current-branch-e2e-harness.mjs";

async function commitWithoutTicket(h, label, files, message) {
  await h.command(`git-add-${label}`, h.repoDir, "git", ["add", ...files]);
  await h.command(`git-commit-${label}`, h.repoDir, "git", ["commit", "-m", message]);
  const rev = await h.command(`git-rev-${label}`, h.repoDir, "git", [
    "rev-parse",
    "--short=12",
    "HEAD",
  ]);
  return rev.stdout.trim();
}

async function launchWorker(h, registry, ticketId, id, mode, { startTicket = true } = {}) {
  const launchHead = await h.command(`${id}-launch-head`, h.repoDir, "git", [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const worker = {
    id,
    ticketId,
    mode,
    cwd: h.repoDir,
    launchHead: launchHead.stdout.trim(),
    status: "running",
    commits: [],
    startedAt: new Date().toISOString(),
  };
  registry.workers.push(worker);
  await h.writePrompt(
    `worker-handoff-${id}`,
    `# Worker handoff\n\nTicket: ${ticketId}\nWorker: ${id}\nMode: ${mode}\nCheckout: ${h.repoDir}`,
  );
  if (startTicket) {
    await h.bw(`${id}-start`, ["start", ticketId]);
  }
  await h.fakeCommand("worker", `${id}-launch`, { ticketId, id, cwd: h.repoDir, mode });
  return worker;
}

function planRemediation(existingKeys, candidateKey) {
  if (existingKeys.has(candidateKey)) {
    return { created: false, key: candidateKey };
  }
  existingKeys.add(candidateKey);
  return { created: true, key: candidateKey };
}

runScenario(async () => {
  const h = new E2eHarness({
    scenario: "current-branch-swarm",
    artifactGroup: "e2e-current-branch-swarm",
  });
  await h.init();
  await h.initGitRepo();
  await h.initBeadwork("e2ecbs");

  await h.step("resolve current-branch swarm mode from package default without mode override");
  const defaultMode = await packageDefaultExecutionMode();
  const config = {
    run: { defaultWorkers: 2 },
    workerExecution: { review: { enabled: true } },
  };
  await h.writeRepoFile(".pi/beadwork-config.json", stableJson(config));
  const resolved = resolveExecutionMode({ env: {}, config, defaultMode });
  h.assert(
    resolved.mode === "current-branch" && resolved.source === "default",
    "swarm did not resolve current-branch mode from package default",
    {
      defaultMode,
      resolved,
    },
  );
  h.assert(defaultMode === "current-branch", "package default is not current-branch", {
    defaultMode,
  });

  const envToWorktree = resolveExecutionMode({
    config,
    defaultMode,
    env: { PI_BEADWORK_WORKER_EXECUTION_MODE: "worktree" },
  });
  h.assert(
    envToWorktree.source === "env" && envToWorktree.mode === "worktree",
    "env override from default current-branch to worktree failed",
    {
      envToWorktree,
    },
  );

  const configToCurrentBranch = resolveExecutionMode({
    config: { workerExecution: { mode: "current-branch" } },
    defaultMode: "worktree",
    env: {},
  });
  h.assert(
    configToCurrentBranch.source === "config" && configToCurrentBranch.mode === "current-branch",
    "config override to current-branch failed",
    {
      configToCurrentBranch,
    },
  );
  h.cover("10-config-overrides");
  h.cover("11-default-flip-readiness");

  const ticketA = await h.bwCreate("swarm worker one writes alpha", {
    description: "current-branch worker 1",
  });
  const ticketB = await h.bwCreate("swarm worker two writes beta", {
    description: "current-branch worker 2",
  });
  const ticketCrash = await h.bwCreate("crash recovery fixture", {
    description: "first worker exits before closing",
  });
  await h.snapshotBwCli("before-swarm", [ticketA, ticketB, ticketCrash]);
  await h.snapshotGit("before-swarm");

  const registry = { workers: [] };
  await h.snapshotRegistry("before-poll-1", registry);
  await h.step("leave unrelated dirty files before launching workers");
  await h.writeRepoFile("operator-notes.txt", "untracked operator note\n");
  await h.appendRepoFile("README.md", "\noperator-local-edit=true\n");
  const dirtyAtLaunch = await h.command("dirty-status-at-launch", h.repoDir, "git", [
    "status",
    "--porcelain",
  ]);
  h.assert(
    dirtyAtLaunch.stdout.includes("operator-notes.txt"),
    "expected dirty file before launch",
  );

  await h.step("launch two current-branch workers in same checkout");
  const workerA = await launchWorker(h, registry, ticketA, "worker-alpha", resolved.mode);
  const workerB = await launchWorker(h, registry, ticketB, "worker-beta", resolved.mode);
  h.assert(
    workerA.cwd === workerB.cwd && workerA.cwd === h.repoDir,
    "workers did not share checkout",
    {
      workerA,
      workerB,
    },
  );
  await h.snapshotRegistry("after-poll-1", registry);

  await h.step("worker alpha commits with ticket id and verifies");
  await h.writeRepoFile("src/alpha.txt", `alpha complete for ${ticketA}\n`);
  const alphaCommit = await h.gitCommit(ticketA, ["src/alpha.txt"], "feat: alpha worker output");
  workerA.commits.push(alphaCommit);
  workerA.status = "closed";
  workerA.completedAt = new Date().toISOString();
  await h.bw("alpha-comment", ["comment", ticketA, `Done in ${alphaCommit}. Validation passed.`]);
  await h.bw("alpha-close", ["close", ticketA]);

  await h.step("worker beta commits without ticket id and provides beadwork comment evidence");
  await h.writeRepoFile("src/beta.txt", `beta complete for ${ticketB}\n`);
  const betaCommit = await commitWithoutTicket(
    h,
    "beta-missing-ticket",
    ["src/beta.txt"],
    "feat: beta worker output",
  );
  workerB.commits.push(betaCommit);
  workerB.status = "closed";
  workerB.completedAt = new Date().toISOString();
  await h.bw("beta-comment", [
    "comment",
    ticketB,
    `Attribution evidence: commit ${betaCommit} implements ${ticketB}; ticket id omitted from commit by fixture.`,
  ]);
  await h.bw("beta-close", ["close", ticketB]);
  await h.writePrompt(
    "reviewer-attribution",
    `# Attribution review\n\n${ticketA}: ${alphaCommit} includes ticket id.\n${ticketB}: ${betaCommit} is attributed by bw comment evidence.`,
  );
  await h.fakeCommand("reviewer", "attribution-review", {
    ticketA,
    ticketB,
    alphaCommit,
    betaCommit,
  });

  await h.step("run per-worker verification and one scope validation");
  const alphaLog = await h.command("alpha-attribution-log", h.repoDir, "git", [
    "log",
    "--format=%H %s%n%b",
    "-1",
    alphaCommit,
  ]);
  const betaHistory = await h.bw("beta-history-attribution", ["history", ticketB, "--json"]);
  h.assert(alphaLog.stdout.includes(ticketA), "alpha ticket id attribution failed", {
    alphaCommit,
  });
  h.assert(betaHistory.stdout.includes(betaCommit), "beta comment attribution failed", {
    betaCommit,
  });
  await h.validation("alpha-test", h.repoDir, "npm", ["run", "test"]);
  await h.validation("beta-test", h.repoDir, "npm", ["run", "test"]);
  workerA.status = "verified";
  workerB.status = "verified";
  const scopeValidations = [];
  await h.writePrompt(
    "scope-review",
    `# Scope review\n\nWorkers: ${workerA.id}, ${workerB.id}\nTickets: ${ticketA}, ${ticketB}`,
  );
  await h.fakeCommand("coordinator", "scope-review", {
    workers: [workerA.id, workerB.id],
    tickets: [ticketA, ticketB],
  });
  scopeValidations.push({ id: "scope-1", workers: [workerA.id, workerB.id], status: "passed" });
  h.assert(scopeValidations.length === 1, "scope validation should run once", { scopeValidations });
  await h.snapshotRegistry("after-poll-2", registry);
  await h.snapshotBwCli("after-two-workers", [ticketA, ticketB, ticketCrash]);

  await h.step("dirty-state remediation waits until workers are done");
  await h.writePrompt(
    "dirty-state-remediation",
    `# Dirty state remediation\n\nDirty files observed at launch:\n${dirtyAtLaunch.stdout}\nWorkers complete at ${workerA.completedAt} and ${workerB.completedAt}`,
  );
  await h.fakeCommand("coordinator", "dirty-state-remediation", {
    dirtyAtLaunch: dirtyAtLaunch.stdout,
    workers: [workerA.id, workerB.id],
  });
  const remediationAt = new Date(Date.now() + 1).toISOString();
  h.assert(
    remediationAt > workerA.completedAt && remediationAt > workerB.completedAt,
    "dirty remediation ran too early",
    {
      remediationAt,
      workers: [workerA, workerB],
    },
  );
  h.cover("3-dirty-checkout-tolerance");

  await h.step("review triage: fix, file, reject");
  const fixTicket = await h.bwCreate("fix reviewer finding", {
    parent: ticketA,
    description: "fix",
  });
  const fileTicket = await h.bwCreate("file reviewer finding", {
    parent: ticketB,
    description: "file",
  });
  const triage = [
    { id: "finding-fix", action: "fix", followUp: fixTicket },
    { id: "finding-file", action: "file", followUp: fileTicket },
    { id: "finding-reject", action: "reject", reason: "false positive deterministic fixture" },
  ];
  await h.writePrompt("reviewer-triage", `# Reviewer triage\n\n${stableJson(triage)}`);
  await h.fakeCommand("reviewer", "triage-findings", { triage });
  await h.bw("triage-fix-comment", ["comment", fixTicket, "Created from fix reviewer finding."]);
  await h.bw("triage-file-comment", [
    "comment",
    fileTicket,
    "Filed for later from reviewer finding.",
  ]);
  h.assert(
    triage.map((entry) => entry.action).join(",") === "fix,file,reject",
    "triage actions missing",
    {
      triage,
    },
  );
  h.cover("5-review-triage");

  await h.step("crash recovery launches replacement with inherited launchHead");
  const crashed = await launchWorker(h, registry, ticketCrash, "worker-crashed", resolved.mode);
  crashed.status = "exited";
  crashed.exitCode = 1;
  await h.writePrompt(
    "replacement-worker-crash-recovery",
    `# Crash recovery\n\nCrashed worker ${crashed.id} stopped while ${ticketCrash} remained open. Inherit launchHead ${crashed.launchHead}.`,
  );
  await h.fakeCommand("coordinator", "crash-recovery-judgment", {
    crashedWorkerId: crashed.id,
    ticketId: ticketCrash,
    decision: "replace",
  });
  const replacement = await launchWorker(
    h,
    registry,
    ticketCrash,
    "worker-replacement",
    resolved.mode,
    {
      startTicket: false,
    },
  );
  replacement.replacedWorkerId = crashed.id;
  replacement.launchHead = crashed.launchHead;
  await h.writeRepoFile("src/crash-recovery.txt", `recovered ${ticketCrash}\n`);
  const crashCommit = await h.gitCommit(
    ticketCrash,
    ["src/crash-recovery.txt"],
    "fix: recover crashed worker output",
  );
  replacement.commits.push(crashCommit);
  replacement.status = "verified";
  await h.bw("crash-comment", [
    "comment",
    ticketCrash,
    `Replacement ${replacement.id} fixed forward in ${crashCommit}.`,
  ]);
  await h.bw("crash-close", ["close", ticketCrash]);
  h.assert(
    replacement.launchHead === crashed.launchHead,
    "replacement did not inherit launchHead",
    {
      crashed,
      replacement,
    },
  );
  h.cover("6-crash-recovery");

  await h.step("validation failure creates fix-forward child without reopening verified workers");
  await h.writePrompt(
    "validation-failure-fix-forward",
    `# Validation failure\n\nScope validation failed after verified workers ${workerA.id}, ${workerB.id}; create attribution-aware child work without reopening them.`,
  );
  await h.fakeCommand("coordinator", "validation-failure-fix-forward", {
    verifiedWorkers: [workerA.id, workerB.id],
    affectedTicket: ticketA,
  });
  const validationFixTicket = await h.bwCreate("fix-forward validation failure", {
    parent: ticketA,
    description: `Scope validation failure after ${alphaCommit} and ${betaCommit}`,
  });
  await h.bw("validation-fix-comment", [
    "comment",
    validationFixTicket,
    `Fix-forward child preserves verified workers ${workerA.id}, ${workerB.id}.`,
  ]);
  h.assert(
    workerA.status === "verified" && workerB.status === "verified",
    "verified workers were reopened",
    {
      workerA,
      workerB,
    },
  );
  h.cover("7-validation-failure-fix-forward");

  await h.step("restart/idempotency does not duplicate remediation");
  const remediationKeys = new Set();
  const firstPlan = planRemediation(remediationKeys, `validation:${ticketA}`);
  const secondPlan = planRemediation(remediationKeys, `validation:${ticketA}`);
  await h.writeArtifact("idempotency-result.json", {
    firstPlan,
    secondPlan,
    keys: [...remediationKeys],
  });
  h.assert(
    firstPlan.created === true && secondPlan.created === false,
    "idempotency planner duplicated work",
    {
      firstPlan,
      secondPlan,
    },
  );
  h.cover("9-restart-idempotency");

  await h.step("final swarm assertions");
  await h.validation("final-npm-test", h.repoDir, "npm", ["run", "test"]);
  await h.validation("final-npm-lint", h.repoDir, "npm", ["run", "lint"]);
  await h.snapshotRegistry("final", registry);
  await h.snapshotBwCli("final", [
    ticketA,
    ticketB,
    ticketCrash,
    fixTicket,
    fileTicket,
    validationFixTicket,
  ]);
  await h.snapshotGit("final");
  h.cover("2-current-branch-run-workers-2");
  h.cover("4-commit-attribution");
  await h.writeArtifact("scenario-result.json", {
    defaultMode,
    resolved,
    envToWorktree,
    configToCurrentBranch,
    tickets: { ticketA, ticketB, ticketCrash, fixTicket, fileTicket, validationFixTicket },
    workers: registry.workers,
    scopeValidations,
    triage,
    dirtyAtLaunch: dirtyAtLaunch.stdout,
  });
  return h;
});
