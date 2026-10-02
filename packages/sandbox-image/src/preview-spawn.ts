import { basename } from "node:path";

const ALLOWED_PREVIEW_EXECUTABLES = new Set([
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "npx",
  "node",
  "python",
  "python3",
  "make",
  "just",
  "cargo",
  "go",
  "deno",
  "uv",
  "ruby",
  "bundle",
]);

/** Suspicious chaining syntax outside quoted segments (spawn uses shell: false, but reject anyway). */
const OUTSIDE_QUOTE_FORBIDDEN = /[;|&`]|(?:\$\()|(?:\$\{)/;

export class PreviewCommandRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewCommandRejectedError";
  }
}

export function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new PreviewCommandRejectedError("Preview command has an unclosed quote");
  }
  if (current) tokens.push(current);
  return tokens;
}

export function resolvePreviewSpawn(command: string): { executable: string; argv: string[] } {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new PreviewCommandRejectedError("Preview command is empty");
  }

  if (containsForbiddenOutsideQuotes(trimmed)) {
    throw new PreviewCommandRejectedError("Preview command contains disallowed shell metacharacters");
  }

  const argv = tokenizeCommandLine(trimmed);
  if (argv.length === 0) {
    throw new PreviewCommandRejectedError("Preview command is empty");
  }

  const executableName = basename(argv[0]);
  if (!ALLOWED_PREVIEW_EXECUTABLES.has(executableName)) {
    throw new PreviewCommandRejectedError(
      `Preview executable "${executableName}" is not allowlisted`,
    );
  }

  return { executable: argv[0], argv: argv.slice(1) };
}

function containsForbiddenOutsideQuotes(input: string): boolean {
  let quote: '"' | "'" | null = null;
  let segment = "";

  const flush = (): boolean => {
    if (OUTSIDE_QUOTE_FORBIDDEN.test(segment)) return true;
    segment = "";
    return false;
  };

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      if (flush()) return true;
      quote = char;
      continue;
    }

    segment += char;
  }

  return flush();
}

const VITE_ALLOWED_HOSTS_ENV = "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS";
const E2B_PREVIEW_HOST_SUFFIX = ".e2b.app";

/**
 * Environment for the preview dev server. On E2B the server is reached as
 * `<port>-<id>.e2b.app`, which Vite 5.4.12+/6.0.9+ rejects with 403 unless the
 * host is allowed; the allowed-hosts variable is merged with any existing value.
 */
export function previewProcessEnv(
  base: NodeJS.ProcessEnv,
  port: number,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    HOST: "0.0.0.0",
    HOSTNAME: "0.0.0.0",
    PORT: String(port),
  };
  if (base.CODEVIL_SANDBOX_PROVIDER === "e2b") {
    const existing = (base[VITE_ALLOWED_HOSTS_ENV] ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean);
    if (!existing.includes(E2B_PREVIEW_HOST_SUFFIX)) existing.push(E2B_PREVIEW_HOST_SUFFIX);
    env[VITE_ALLOWED_HOSTS_ENV] = existing.join(",");
  }
  return env;
}
