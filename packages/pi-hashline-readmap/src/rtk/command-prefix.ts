const ASSIGNMENT_PREFIX = /^[a-z_][a-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+)\s+/i;
const COMMAND_WRAPPER_PREFIX = /^command\s+/i;
const SHELL_TOKEN_PREFIX = /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+)(?:\s+|$)/;
const SUDO_OPTIONS_WITH_VALUE = new Set([
  "--auth-type",
  "--chdir",
  "--chroot",
  "--close-from",
  "--command-timeout",
  "--group",
  "--host",
  "--login-class",
  "--other-user",
  "--prompt",
  "--role",
  "--type",
  "--user",
]);
const SUDO_SHORT_OPTIONS_WITH_VALUE = new Set([
  "a",
  "C",
  "D",
  "g",
  "h",
  "p",
  "R",
  "r",
  "T",
  "t",
  "U",
  "u",
]);

function stripToken(command: string): string | null {
  const match = command.match(SHELL_TOKEN_PREFIX);
  return match ? command.slice(match[0].length).trimStart() : null;
}

function sudoOptionTakesSeparateValue(option: string): boolean {
  if (SUDO_OPTIONS_WITH_VALUE.has(option)) return true;
  if (option.startsWith("--") || !option.startsWith("-") || option.length < 2) return false;

  for (let index = 1; index < option.length; index += 1) {
    if (SUDO_SHORT_OPTIONS_WITH_VALUE.has(option[index] ?? "")) {
      return index === option.length - 1;
    }
  }

  return false;
}

function stripSudoPrefix(command: string): string {
  if (!/^sudo\s+/i.test(command)) return command;

  let normalized = command.replace(/^sudo\s+/i, "");
  while (normalized.startsWith("-")) {
    const optionMatch = normalized.match(/^(\S+)(?:\s+|$)/);
    if (!optionMatch) return normalized;

    const option = optionMatch[1] ?? "";
    normalized = normalized.slice(optionMatch[0].length).trimStart();
    if (option === "--") break;

    if (sudoOptionTakesSeparateValue(option)) {
      const remainder = stripToken(normalized);
      if (remainder === null) return "";
      normalized = remainder;
    }
  }

  return normalized;
}

function normalizeCommandStart(command: string): string {
  let normalized = command.trimStart();
  let previous = "";

  while (normalized !== previous) {
    previous = normalized;
    normalized = normalized.replace(ASSIGNMENT_PREFIX, "");
    normalized = stripSudoPrefix(normalized).replace(COMMAND_WRAPPER_PREFIX, "");
    if (/^env\s+/i.test(normalized)) normalized = normalized.replace(/^env\s+/i, "");
  }

  return normalized.toLowerCase().replace(/\s+/g, " ");
}

export function startsWithCommand(
  command: string | undefined | null,
  prefixes: readonly string[],
): boolean {
  if (typeof command !== "string" || command.length === 0) return false;

  const normalized = normalizeCommandStart(command);
  return prefixes.some((prefix) => {
    const normalizedPrefix = prefix.toLowerCase();
    return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix} `);
  });
}
