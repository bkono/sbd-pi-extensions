import { describe, expect, it } from "vitest";
import { defaultProcessRunner, type ProcessCommandError } from "../../process.js";

describe("defaultProcessRunner", () => {
  it("streams stdout and stderr chunks while capturing final output", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const result = await defaultProcessRunner(
      process.execPath,
      ["-e", 'process.stdout.write("hello\\n"); process.stderr.write("warn\\n");'],
      {
        onStdoutChunk: (chunk) => stdoutChunks.push(chunk),
        onStderrChunk: (chunk) => stderrChunks.push(chunk),
      },
    );

    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("warn\n");
    expect(stdoutChunks.join("")).toBe("hello\n");
    expect(stderrChunks.join("")).toBe("warn\n");
  });

  it("preserves truthful timeout details", async () => {
    await expect(
      defaultProcessRunner(
        process.execPath,
        ["-e", 'setTimeout(() => process.stdout.write("done"), 1000);'],
        { timeout: 50 },
      ),
    ).rejects.toMatchObject<Partial<ProcessCommandError>>({
      code: 124,
      timedOut: true,
      timeoutMs: 50,
    });

    await expect(
      defaultProcessRunner(
        process.execPath,
        ["-e", 'setTimeout(() => process.stdout.write("done"), 1000);'],
        { timeout: 50 },
      ),
    ).rejects.toThrow(/timed out after 50ms/);
  });
});
