import { describe, expect, it } from "vitest";
import { buildBashCommandState } from "../src/bash-command-state.js";

describe("buildBashCommandState", () => {
  it("classifies git repo-state, history, and mutation commands", () => {
    expect(
      buildBashCommandState({
        command: " git   status --short ",
        isError: false,
        text: " M src/a.ts",
      }),
    ).toMatchObject({
      normalizedCommand: "git status --short",
      commandKind: "vcs",
      stateKind: "repo-status",
      outcome: "success",
      semanticInvalidationSensitive: true,
      routineRetirementEligible: false,
      protectedFromRoutineRetirement: false,
    });

    expect(
      buildBashCommandState({
        command: "git diff -- src/a.ts",
        isError: false,
        text: "diff --git a/src/a.ts b/src/a.ts",
      }),
    ).toMatchObject({
      normalizedCommand: "git diff -- src/a.ts",
      commandKind: "vcs",
      stateKind: "repo-diff",
      outcome: "success",
      semanticInvalidationSensitive: true,
      routineRetirementEligible: false,
    });

    expect(
      buildBashCommandState({
        command: "git log --oneline -5",
        isError: false,
        text: "abc commit",
      }),
    ).toMatchObject({
      normalizedCommand: "git log --oneline -5",
      commandKind: "vcs",
      stateKind: "git-history",
      outcome: "success",
      semanticInvalidationSensitive: false,
      routineRetirementEligible: true,
    });

    expect(
      buildBashCommandState({ command: "git add src/a.ts", isError: false, text: "" }),
    ).toMatchObject({
      normalizedCommand: "git add src/a.ts",
      commandKind: "vcs",
      stateKind: "git-worktree-mutation",
      outcome: "success",
      protectedFromRoutineRetirement: true,
    });
  });

  it("classifies verification commands with exact normalized targets", () => {
    expect(
      buildBashCommandState({ command: "npm test", isError: true, text: "FAIL tests/a.test.ts" }),
    ).toMatchObject({
      normalizedCommand: "npm test",
      commandKind: "test",
      stateKind: "verification",
      outcome: "failure",
      protectedFromRoutineRetirement: true,
      routineRetirementEligible: false,
    });

    expect(
      buildBashCommandState({
        command: "npm test -- tests/a.test.ts",
        isError: false,
        text: "PASS tests/a.test.ts",
      }),
    ).toMatchObject({
      normalizedCommand: "npm test -- tests/a.test.ts",
      commandKind: "test",
      stateKind: "verification",
      outcome: "success",
      protectedFromRoutineRetirement: false,
      routineRetirementEligible: true,
    });
  });

  it("protects diagnostics and unusual debugging output from routine retirement", () => {
    expect(
      buildBashCommandState({
        command: "node debug-script.js",
        isError: false,
        text: "TypeError: boom\n    at main (debug-script.js:1:1)",
      }),
    ).toMatchObject({
      normalizedCommand: "node debug-script.js",
      commandKind: "other",
      stateKind: "debug",
      outcome: "success",
      containsDiagnostics: true,
      protectedFromRoutineRetirement: true,
      routineRetirementEligible: false,
    });
  });

  it("classifies append redirection as a shell file mutation", () => {
    const cwd = "/tmp/hashline-bash-targets";
    const state = buildBashCommandState({ command: "printf next >> logs/out.txt", cwd, text: "" });

    expect(state.stateKind).toBe("shell-file-mutation");
    expect(state.normalizedCommand).toBe("printf next >> logs/out.txt");
    expect(state.commandKind).toBe("other");
    expect(state.protectedFromRoutineRetirement).toBe(true);
    expect(state.routineRetirementEligible).toBe(false);
    expect(state.fileTargets).toEqual(["/tmp/hashline-bash-targets/logs/out.txt"]);
  });

  it("classifies tee output files as shell file mutation targets", () => {
    const cwd = "/tmp/hashline-bash-targets";
    const teeState = buildBashCommandState({
      command: "printf next | tee logs/out.txt",
      cwd,
      text: "next",
    });
    const appendTeeState = buildBashCommandState({
      command: "printf next | tee -a logs/a.txt logs/b.txt",
      cwd,
      text: "next",
    });

    expect(teeState.stateKind).toBe("shell-file-mutation");
    expect(teeState.protectedFromRoutineRetirement).toBe(true);
    expect(teeState.routineRetirementEligible).toBe(false);
    expect(teeState.fileTargets).toEqual(["/tmp/hashline-bash-targets/logs/out.txt"]);

    expect(appendTeeState.stateKind).toBe("shell-file-mutation");
    expect(appendTeeState.protectedFromRoutineRetirement).toBe(true);
    expect(appendTeeState.routineRetirementEligible).toBe(false);
    expect(appendTeeState.fileTargets).toEqual([
      "/tmp/hashline-bash-targets/logs/a.txt",
      "/tmp/hashline-bash-targets/logs/b.txt",
    ]);
  });

  it("classifies heredoc redirection as a shell file mutation", () => {
    const cwd = "/tmp/hashline-bash-targets";
    const state = buildBashCommandState({
      command: "cat > generated.ts <<'EOF'\nexport const value = 1;\nEOF",
      cwd,
      text: "",
    });

    expect(state.stateKind).toBe("shell-file-mutation");
    expect(state.protectedFromRoutineRetirement).toBe(true);
    expect(state.routineRetirementEligible).toBe(false);
    expect(state.fileTargets).toEqual(["/tmp/hashline-bash-targets/generated.ts"]);
  });

  it("classifies sed in-place edits as shell file mutations", () => {
    const cwd = "/tmp/hashline-bash-targets";
    const bsdState = buildBashCommandState({
      command: "sed -i '' 's/old/new/' src/example.ts",
      cwd,
      text: "",
    });
    const gnuState = buildBashCommandState({
      command: "sed -i 's/old/new/' src/other.ts",
      cwd,
      text: "",
    });

    expect(bsdState.stateKind).toBe("shell-file-mutation");
    expect(bsdState.protectedFromRoutineRetirement).toBe(true);
    expect(bsdState.routineRetirementEligible).toBe(false);
    expect(bsdState.fileTargets).toEqual(["/tmp/hashline-bash-targets/src/example.ts"]);

    expect(gnuState.stateKind).toBe("shell-file-mutation");
    expect(gnuState.protectedFromRoutineRetirement).toBe(true);
    expect(gnuState.routineRetirementEligible).toBe(false);
    expect(gnuState.fileTargets).toEqual(["/tmp/hashline-bash-targets/src/other.ts"]);
  });

  it("classifies mv source and destination as shell file mutation targets", () => {
    const cwd = "/tmp/hashline-bash-targets";
    const state = buildBashCommandState({ command: "mv src/old.ts src/new.ts", cwd, text: "" });

    expect(state.stateKind).toBe("shell-file-mutation");
    expect(state.protectedFromRoutineRetirement).toBe(true);
    expect(state.routineRetirementEligible).toBe(false);
    expect(state.fileTargets).toEqual([
      "/tmp/hashline-bash-targets/src/old.ts",
      "/tmp/hashline-bash-targets/src/new.ts",
    ]);
  });

  it("classifies cp destination as a shell file mutation target", () => {
    const cwd = "/tmp/hashline-bash-targets";
    const state = buildBashCommandState({ command: "cp src/source.ts src/copy.ts", cwd, text: "" });

    expect(state.stateKind).toBe("shell-file-mutation");
    expect(state.protectedFromRoutineRetirement).toBe(true);
    expect(state.routineRetirementEligible).toBe(false);
    expect(state.fileTargets).toEqual(["/tmp/hashline-bash-targets/src/copy.ts"]);
  });

  it("classifies rm operands as shell file mutation targets", () => {
    const cwd = "/tmp/hashline-bash-targets";
    const state = buildBashCommandState({
      command: "rm -f src/delete-a.ts src/delete-b.ts",
      cwd,
      text: "",
    });

    expect(state.stateKind).toBe("shell-file-mutation");
    expect(state.protectedFromRoutineRetirement).toBe(true);
    expect(state.routineRetirementEligible).toBe(false);
    expect(state.fileTargets).toEqual([
      "/tmp/hashline-bash-targets/src/delete-a.ts",
      "/tmp/hashline-bash-targets/src/delete-b.ts",
    ]);
  });

  it("classifies install destination as a shell file mutation target", () => {
    const cwd = "/tmp/hashline-bash-targets";
    const state = buildBashCommandState({
      command: "install -m 0644 build/out.d.ts src/out.d.ts",
      cwd,
      text: "",
    });

    expect(state.stateKind).toBe("shell-file-mutation");
    expect(state.protectedFromRoutineRetirement).toBe(true);
    expect(state.routineRetirementEligible).toBe(false);
    expect(state.fileTargets).toEqual(["/tmp/hashline-bash-targets/src/out.d.ts"]);
  });

  it("does not invent file targets inside eval commands", () => {
    const cwd = "/tmp/hashline-bash-targets";
    const state = buildBashCommandState({
      command: "eval 'printf changed > src/generated.ts'",
      cwd,
      text: "",
    });

    expect(state.stateKind).toBe("debug");
    expect(state.fileTargets).toBeUndefined();
  });
});
