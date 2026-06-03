// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ANSI escape bytes.
const STANDARD_ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ANSI OSC/control bytes.
const OSC_ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(STANDARD_ANSI_RE, "").replace(OSC_ANSI_RE, "");
}

export function stripAnsiFast(text: string): string {
  if (!text.includes("\x1b")) {
    return text;
  }
  return stripAnsi(text);
}
