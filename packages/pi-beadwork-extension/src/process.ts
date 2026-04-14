import { execFile } from "node:child_process";

export type ProcessResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export class ProcessCommandError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: {
    command: string;
    args: string[];
    cwd?: string;
    code: number;
    stdout?: string;
    stderr?: string;
  }) {
    const rendered = [input.command, ...input.args].join(" ");
    const stderr = input.stderr ?? "";
    const stdout = input.stdout ?? "";
    const detail = stderr.trim() || stdout.trim() || `exit code ${input.code}`;
    super(`Command failed: ${rendered} (${detail})`);
    this.name = "ProcessCommandError";
    this.command = input.command;
    this.args = input.args;
    this.cwd = input.cwd;
    this.code = input.code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<ProcessResult>;

export const DEFAULT_TIMEOUT_MS = 15_000;

export const defaultProcessRunner: ProcessRunner = async (
  command,
  args,
  options = {},
): Promise<ProcessResult> => {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new ProcessCommandError({
              command,
              args,
              cwd: options.cwd,
              code: typeof error.code === "number" ? error.code : 1,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
            }),
          );
          return;
        }

        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: 0,
        });
      },
    );
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
