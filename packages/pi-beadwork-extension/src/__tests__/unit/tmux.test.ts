import { describe, expect, it, vi } from "vitest";
import { createTmuxBackend } from "../../tmux.js";

describe("tmux backend", () => {
  it("creates a tmux session when it does not already exist", async () => {
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing session"))
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0 });
    const backend = createTmuxBackend(runner);

    const result = await backend.ensureSession({ sessionName: "pi-bw" });

    expect(result).toEqual({ sessionName: "pi-bw", created: true });
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "tmux",
      ["new-session", "-d", "-s", "pi-bw", "-n", "beadwork"],
      { timeout: 5_000 },
    );
  });

  it("launches a worker window and returns the pane id", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: "bw-worker\t%42\n",
      stderr: "",
      code: 0,
    });
    const backend = createTmuxBackend(runner);

    const result = await backend.launchWorker({
      sessionName: "pi-bw",
      workerId: "bw-worker",
      title: "Fix auth",
      worktreePath: "/tmp/worktree",
      launchCommand: "bash /tmp/worker.sh",
    });

    expect(result.paneId).toBe("%42");
    expect(runner).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["new-window", "-t", "pi-bw", "-c", "/tmp/worktree"]),
      { timeout: 10_000 },
    );
  });

  it("falls back to session/window when a pane id was reused", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: "%2\tpi-bw\told-worker\t0\tbash\t100\t\n%7\tpi-bw\tbw-worker\t0\tbash\t101\t\n",
      stderr: "",
      code: 0,
    });
    const backend = createTmuxBackend(runner);

    const result = await backend.inspectWorker({
      paneId: "%2",
      sessionName: "pi-bw",
      windowName: "bw-worker",
    });

    expect(result).toMatchObject({
      exists: true,
      paneId: "%7",
      sessionName: "pi-bw",
      windowName: "bw-worker",
    });
  });

  it("prefers killing the worker window over a possibly reused pane id", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const backend = createTmuxBackend(runner);

    await backend.cleanupWorker({
      paneId: "%42",
      sessionName: "pi-bw",
      windowName: "bw-worker",
    });

    expect(runner).toHaveBeenCalledWith("tmux", ["kill-window", "-t", "pi-bw:bw-worker"], {
      timeout: 5_000,
    });
  });
});
