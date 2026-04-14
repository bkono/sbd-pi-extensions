import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectActivation } from "../../activation.js";

const { accessMock, execFileMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  access: accessMock,
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("detectActivation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    accessMock.mockResolvedValue(undefined);
    execFileMock.mockReset();
  });

  it("returns inactive when cwd is unavailable", async () => {
    accessMock.mockRejectedValueOnce(new Error("missing"));

    await expect(detectActivation("/missing")).resolves.toMatchObject({
      kind: "inactive",
      reason: "cwd-unavailable",
    });
  });

  it("returns inactive when cwd is not in a git repo", async () => {
    execFileMock.mockImplementation((command, _args, options, callback) => {
      if (command === "git" && options?.cwd === "/repo") {
        callback(Object.assign(new Error("not a repo"), { code: 128 }));
        return;
      }
      callback(null, "", "");
    });

    await expect(detectActivation("/repo")).resolves.toMatchObject({
      kind: "inactive",
      reason: "no-git",
    });
  });

  it("returns inactive when bw is not installed", async () => {
    execFileMock.mockImplementation((command, _args, options, callback) => {
      if (command === "git" && options?.cwd === "/repo") {
        callback(null, "/repo\n", "");
        return;
      }
      if (command === "bw") {
        callback(Object.assign(new Error("missing bw"), { code: "ENOENT" }));
        return;
      }
      callback(null, "", "");
    });

    await expect(detectActivation("/repo")).resolves.toMatchObject({
      kind: "inactive",
      reason: "no-bw",
      repoRoot: "/repo",
    });
  });

  it("returns available when beadwork branch is missing", async () => {
    execFileMock.mockImplementation((command, args, _options, callback) => {
      if (command === "git" && args[0] === "rev-parse") {
        callback(null, "/repo\n", "");
        return;
      }
      if (command === "bw") {
        callback(null, "usage", "");
        return;
      }
      if (command === "git" && args[0] === "show-ref") {
        callback(Object.assign(new Error("missing branch"), { code: 1 }));
        return;
      }
      callback(null, "", "");
    });

    await expect(detectActivation("/repo")).resolves.toMatchObject({
      kind: "available",
      reason: "repo-not-initialized",
      repoRoot: "/repo",
    });
  });

  it("returns active when beadwork branch exists", async () => {
    execFileMock.mockImplementation((command, args, _options, callback) => {
      if (command === "git" && args[0] === "rev-parse") {
        callback(null, "/repo\n", "");
        return;
      }
      if (command === "bw") {
        callback(null, "usage", "");
        return;
      }
      if (command === "git" && args[0] === "show-ref") {
        callback(null, "", "");
        return;
      }
      callback(null, "", "");
    });

    await expect(detectActivation("/repo")).resolves.toEqual({
      kind: "active",
      repoRoot: "/repo",
    });
  });
});
