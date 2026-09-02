const ASSIGNMENT_PREFIX = /^[a-z_][a-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]*)\s+/i;
const SHELL_TOKEN_PREFIX = /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+)(?:\s+|$)/;

type OptionDisposition = "continue" | "consume-value" | "reject";

interface WrapperOptions {
  longFlags: ReadonlySet<string>;
  longValues: ReadonlySet<string>;
  longRejects: ReadonlySet<string>;
  longOptionalValues: ReadonlySet<string>;
  shortFlags: ReadonlySet<string>;
  shortValues: ReadonlySet<string>;
  shortRejects: ReadonlySet<string>;
}

const COMMAND_OPTIONS: WrapperOptions = {
  longFlags: new Set(),
  longValues: new Set(),
  longOptionalValues: new Set(),
  longRejects: new Set(),
  shortFlags: new Set("p"),
  shortValues: new Set(),
  shortRejects: new Set("vV"),
};

const ENV_OPTIONS: WrapperOptions = {
  longFlags: new Set(["--debug", "--ignore-environment", "--null"]),
  longValues: new Set(["--chdir", "--unset"]),
  longOptionalValues: new Set(),
  longRejects: new Set(["--help", "--split-string", "--version"]),
  shortFlags: new Set("i0v"),
  shortValues: new Set("uC"),
  shortRejects: new Set("S"),
};

const SUDO_OPTIONS: WrapperOptions = {
  longFlags: new Set([
    "--askpass",
    "--background",
    "--bell",
    "--login",
    "--no-update",
    "--non-interactive",
    "--preserve-groups",
    "--reset-timestamp",
    "--set-home",
    "--shell",
    "--stdin",
  ]),
  longValues: new Set([
    "--auth-type",
    "--chdir",
    "--chroot",
    "--close-from",
    "--command-timeout",
    "--group",
    "--host",
    "--login-class",
    "--prompt",
    "--role",
    "--type",
    "--user",
  ]),
  longOptionalValues: new Set(["--preserve-env"]),
  longRejects: new Set([
    "--edit",
    "--help",
    "--list",
    "--other-user",
    "--remove-timestamp",
    "--validate",
    "--version",
  ]),
  shortFlags: new Set("AbBEHikNnPSs"),
  shortValues: new Set("aCDghpRrTtu"),
  shortRejects: new Set("eKlUVv"),
};

function stripToken(command: string): string | null {
  const match = command.match(SHELL_TOKEN_PREFIX);
  return match ? command.slice(match[0].length).trimStart() : null;
}

function optionDisposition(option: string, options: WrapperOptions): OptionDisposition {
  if (option.startsWith("--")) {
    const [name] = option.split("=", 2);
    if (!name || options.longRejects.has(name)) return "reject";
    if (options.longOptionalValues.has(name)) return "continue";
    if (options.longValues.has(name)) {
      return option.includes("=") ? "continue" : "consume-value";
    }
    if (options.longFlags.has(name)) return option.includes("=") ? "reject" : "continue";
    return "reject";
  }

  for (let index = 1; index < option.length; index += 1) {
    const flag = option[index] ?? "";
    if (options.shortRejects.has(flag)) return "reject";
    if (options.shortValues.has(flag)) {
      return index === option.length - 1 ? "consume-value" : "continue";
    }
    if (!options.shortFlags.has(flag)) return "reject";
  }

  return "continue";
}

function stripWrapper(command: string, wrapper: string, options: WrapperOptions): string | null {
  const wrapperPrefix = new RegExp(`^${wrapper}\\s+`, "i");
  if (!wrapperPrefix.test(command)) return command;

  let normalized = command.replace(wrapperPrefix, "");
  while (normalized.startsWith("-")) {
    const optionMatch = normalized.match(/^(\S+)(?:\s+|$)/);
    if (!optionMatch) return null;

    const option = optionMatch[1] ?? "";
    normalized = normalized.slice(optionMatch[0].length).trimStart();
    if (option === "--") break;

    const disposition = optionDisposition(option, options);
    if (disposition === "reject") return null;
    if (disposition === "consume-value") {
      const remainder = stripToken(normalized);
      if (remainder === null) return null;
      normalized = remainder;
    }
  }

  return normalized;
}

function normalizeCommandStart(command: string): string | null {
  let normalized = command.trimStart();
  let allowAssignments = true;

  while (true) {
    if (allowAssignments) {
      let withoutAssignment = normalized.replace(ASSIGNMENT_PREFIX, "");
      while (withoutAssignment !== normalized) {
        normalized = withoutAssignment;
        withoutAssignment = normalized.replace(ASSIGNMENT_PREFIX, "");
      }
    }

    let strippedWrapper = false;
    for (const [wrapper, options, assignmentsMayFollow] of [
      ["command", COMMAND_OPTIONS, false],
      ["sudo", SUDO_OPTIONS, true],
      ["env", ENV_OPTIONS, true],
    ] as const) {
      const remainder = stripWrapper(normalized, wrapper, options);
      if (remainder === null) return null;
      if (remainder !== normalized) {
        normalized = remainder;
        allowAssignments = assignmentsMayFollow;
        strippedWrapper = true;
        break;
      }
    }

    if (!strippedWrapper) break;
  }

  return normalized.toLowerCase().replace(/\s+/g, " ");
}

export function startsWithCommand(
  command: string | undefined | null,
  prefixes: readonly string[],
): boolean {
  if (typeof command !== "string" || command.length === 0) return false;

  const normalized = normalizeCommandStart(command);
  if (normalized === null) return false;
  return prefixes.some((prefix) => {
    const normalizedPrefix = prefix.toLowerCase();
    return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix} `);
  });
}
