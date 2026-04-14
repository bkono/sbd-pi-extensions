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
});
