export type ParsedArgv = {
  positional: string[];
  options: Map<string, string | true>;
};

export type ParsedModelOverride = {
  provider?: string;
  model: string;
};

export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;

  for (const match of input.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }

  return tokens;
}

export function parseArgv(input: string): ParsedArgv {
  const tokens = tokenizeArgs(input);
  const positional: string[] = [];
  const options = new Map<string, string | true>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const [name, inlineValue] = token.slice(2).split("=", 2);
    if (!name) {
      continue;
    }

    if (inlineValue !== undefined) {
      options.set(name, inlineValue);
      continue;
    }

    const next = tokens[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(name, next);
      index += 1;
      continue;
    }

    options.set(name, true);
  }

  return { positional, options };
}

export function parseModelOverride(value: string): ParsedModelOverride {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Model override cannot be empty.");
  }

  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex === -1) {
    return { model: trimmed };
  }

  const provider = trimmed.slice(0, separatorIndex).trim();
  const model = trimmed.slice(separatorIndex + 1).trim();
  if (!provider || !model) {
    throw new Error(
      `Invalid model override: ${value}. Expected provider/model or a bare model name.`,
    );
  }

  return { provider, model };
}
