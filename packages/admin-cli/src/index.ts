import { configureProviders, type Output } from "./configure-providers.js";
import {
  createTerminalPrompt,
  PromptCancelledError,
  type Prompt,
} from "./prompt.js";

export async function runCli(
  args: string[],
  options: {
    prompt?: Prompt;
    configureProviders?: () => Promise<void>;
    output?: Output;
    setExitCode?: (code: number) => void;
  } = {},
): Promise<void> {
  const prompt = options.prompt ?? createTerminalPrompt();
  const output = options.output ?? createConsoleOutput();
  const setExitCode = options.setExitCode ?? ((code: number) => {
    process.exitCode = code;
  });
  const configureProvidersCommand = options.configureProviders ?? (() =>
    configureProviders({
      prompt,
      output,
    }));

  const [command] = args;

  if (!command || command === "--help" || command === "-h") {
    printHelp(output);
    setExitCode(0);
    return;
  }

  if (command !== "providers") {
    output.error(`Unknown command: ${command}`);
    printHelp(output);
    setExitCode(1);
    return;
  }

  if (!prompt.isTTY()) {
    output.error(
      "Provider setup requires an interactive terminal. This command does not support key flags or argv-based secrets.",
    );
    setExitCode(1);
    return;
  }

  try {
    await configureProvidersCommand();
    setExitCode(0);
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      output.error("Cancelled.");
      setExitCode(130);
      return;
    }

    output.error(getSafeErrorMessage(error));
    setExitCode(1);
  }
}

function printHelp(output: Output) {
  output.log("Usage: admin-cli <command>");
  output.log("Commands:");
  output.log("  providers    Configure provider credentials interactively");
  output.log("  --help, -h   Show this help message");
}

function createConsoleOutput(): Output {
  return {
    log(message) {
      console.log(message);
    },
    error(message) {
      console.error(message);
    },
  };
}

function getSafeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

if (isDirectExecution()) {
  await runCli(process.argv.slice(2));
}

function isDirectExecution() {
  return import.meta.url === new URL(process.argv[1], "file:").href;
}
