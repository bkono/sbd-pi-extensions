import { spawn } from "node:child_process";

export type ProcessResult = {
  stdout: string;
  stderr: string;
  code: number;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  killed?: boolean;
};

function truncateDetail(value: string, maxLength = 500): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength).trimEnd()}…`;
}

export class ProcessCommandError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal?: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly killed: boolean;
  readonly timeoutMs?: number;

  constructor(input: {
    command: string;
    args: string[];
    cwd?: string;
    code: number;
    stdout?: string;
    stderr?: string;
    signal?: NodeJS.Signals | null;
    timedOut?: boolean;
    killed?: boolean;
    timeoutMs?: number;
  }) {
    const rendered = [input.command, ...input.args].join(" ");
    const stderr = input.stderr ?? "";
    const stdout = input.stdout ?? "";
    const detailParts: string[] = [];

    if (input.timedOut) {
      detailParts.push(input.timeoutMs ? `timed out after ${input.timeoutMs}ms` : "timed out");
    }

    if (input.signal) {
      detailParts.push(`signal ${input.signal}`);
    }

    const ioDetail = truncateDetail(stderr || stdout);
    if (ioDetail) {
      detailParts.push(ioDetail);
    }

    if (detailParts.length === 0) {
      detailParts.push(`exit code ${input.code}`);
    }

    super(`Command failed: ${rendered} (${detailParts.join("; ")})`);
    this.name = "ProcessCommandError";
    this.command = input.command;
    this.args = input.args;
    this.cwd = input.cwd;
    this.code = input.code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.signal = input.signal;
    this.timedOut = input.timedOut ?? false;
    this.killed = input.killed ?? false;
    this.timeoutMs = input.timeoutMs;
  }
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    timeout?: number;
    signal?: AbortSignal;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  },
) => Promise<ProcessResult>;

export const DEFAULT_TIMEOUT_MS = 15_000;

export const defaultProcessRunner: ProcessRunner = async (
  command,
  args,
  options = {},
): Promise<ProcessResult> => {
  return new Promise((resolve, reject) => {
    const effectiveTimeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let forcedKillHandle: NodeJS.Timeout | undefined;

    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });

    const cleanupTimers = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (forcedKillHandle) {
        clearTimeout(forcedKillHandle);
      }
    };

    const finishWithError = (error: ProcessCommandError): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanupTimers();
      reject(error);
    };

    const finishWithResult = (result: ProcessResult): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanupTimers();
      resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdoutChunk?.(chunk);
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderrChunk?.(chunk);
    });

    child.once("error", (error) => {
      const message = error.message.trim();
      const errorCode = (error as NodeJS.ErrnoException).code;
      finishWithError(
        new ProcessCommandError({
          command,
          args,
          cwd: options.cwd,
          code: typeof errorCode === "number" ? errorCode : 1,
          stdout,
          stderr: message ? `${stderr}${stderr ? "\n" : ""}${message}` : stderr,
          signal: null,
          timedOut,
          killed: child.killed,
          timeoutMs: effectiveTimeout,
        }),
      );
    });

    child.once("close", (code, signal) => {
      const numericCode = typeof code === "number" ? code : timedOut ? 124 : 1;
      const result = {
        stdout,
        stderr,
        code: numericCode,
        signal,
        timedOut,
        killed: child.killed,
      } satisfies ProcessResult;

      if (numericCode !== 0 || signal) {
        finishWithError(
          new ProcessCommandError({
            command,
            args,
            cwd: options.cwd,
            code: numericCode,
            stdout,
            stderr,
            signal,
            timedOut,
            killed: child.killed,
            timeoutMs: effectiveTimeout,
          }),
        );
        return;
      }

      finishWithResult(result);
    });

    if (effectiveTimeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forcedKillHandle = setTimeout(() => {
          if (!finished) {
            child.kill("SIGKILL");
          }
        }, 2_000);
      }, effectiveTimeout);
    }
  });
};

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function slugify(value: string, maxLength = 48): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");

  return slug || "work";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
