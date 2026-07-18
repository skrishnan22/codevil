export interface InitCommand {
  type: "init";
  endpoint?: string;
  apiKey?: string;
  provider?: string;
  planModel?: string;
  execModel?: string;
}

export interface RunCommand {
  type: "run";
  repo: string;
  prompt: string;
  provider?: string;
  planModel?: string;
  execModel?: string;
  maxTime?: string;
  debug?: boolean;
}

export interface HelpCommand {
  type: "help";
}

export interface ModelsListCommand {
  type: "models-list";
  provider: string;
}

export interface ModelsCheckCommand {
  type: "models-check";
  provider: string;
  modelId: string;
}

export type Command = InitCommand | RunCommand | HelpCommand | ModelsListCommand | ModelsCheckCommand;

const runFlags = new Set(["--debug"]);

const runOptions = new Set([
  "--repo",
  "--provider",
  "--plan-model",
  "--exec-model",
  "--max-time",
]);

const initOptions = new Set(["--endpoint", "--api-key", "--provider", "--plan-model", "--exec-model"]);

export function parseCommand(argv: string[]): Command {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    return { type: "help" };
  }

  if (command === "init") return parseInit(rest);
  if (command === "run") return parseRun(rest);
  if (command === "models") return parseModels(rest);

  throw new Error(`Unknown command: ${command}`);
}

function parseModels(argv: string[]): ModelsListCommand | ModelsCheckCommand {
  const [subcommand, ...rest] = argv;

  if (subcommand === "list") {
    let provider = "opencode-go";
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index];
      if (arg === "--provider") {
        provider = readOptionValue(rest, index, arg);
        index++;
        continue;
      }
      throw new Error(`Unknown option: ${arg}`);
    }
    return { type: "models-list", provider };
  }

  if (subcommand === "check") {
    const ref = rest[0];
    if (!ref || ref.startsWith("--")) {
      throw new Error("Usage: codevil models check <provider>/<model>");
    }
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) {
      throw new Error(`Expected provider/model, got: ${ref}`);
    }
    return {
      type: "models-check",
      provider: ref.slice(0, slash),
      modelId: ref.slice(slash + 1),
    };
  }

  throw new Error(`Unknown models subcommand: ${subcommand ?? "(missing)"}`);
}

function parseInit(argv: string[]): InitCommand {
  const parsed: InitCommand = { type: "init" };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!initOptions.has(arg)) throw new Error(`Unknown option: ${arg}`);

    const value = readOptionValue(argv, index, arg);
    index++;

    if (arg === "--endpoint") parsed.endpoint = value;
    if (arg === "--api-key") parsed.apiKey = value;
    if (arg === "--provider") parsed.provider = value;
    if (arg === "--plan-model") parsed.planModel = value;
    if (arg === "--exec-model") parsed.execModel = value;
  }

  return parsed;
}

function parseRun(argv: string[]): RunCommand {
  const promptParts: string[] = [];
  const parsed: Partial<RunCommand> = { type: "run" };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg.startsWith("--")) {
      if (runFlags.has(arg)) {
        if (arg === "--debug") parsed.debug = true;
        continue;
      }

      if (!runOptions.has(arg)) throw new Error(`Unknown option: ${arg}`);

      const value = readOptionValue(argv, index, arg);
      index++;

      switch (arg) {
        case "--repo":
          parsed.repo = value;
          break;
        case "--provider":
          parsed.provider = value;
          break;
        case "--plan-model":
          parsed.planModel = value;
          break;
        case "--exec-model":
          parsed.execModel = value;
          break;
        case "--max-time":
          parsed.maxTime = value;
          break;
      }
    } else {
      promptParts.push(arg);
    }
  }

  if (!parsed.repo) throw new Error("Missing required option: --repo");

  const prompt = promptParts.join(" ").trim();
  if (!prompt) throw new Error("Missing task prompt");

  return {
    type: "run",
    repo: parsed.repo,
    prompt,
    provider: parsed.provider,
    planModel: parsed.planModel,
    execModel: parsed.execModel,
    maxTime: parsed.maxTime,
    debug: parsed.debug,
  };
}

function readOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

export function usage(): string {
  return [
    "Usage:",
    "  codevil init [--endpoint URL] [--api-key KEY] [--provider PROVIDER] [--plan-model MODEL] [--exec-model MODEL]",
    "  codevil run --repo REPO_URL [--provider PROVIDER] [--plan-model MODEL] [--exec-model MODEL] [--max-time TIME] [--debug] <prompt>",
    "  codevil models list [--provider PROVIDER]",
    "  codevil models check <provider>/<model>",
  ].join("\n");
}
