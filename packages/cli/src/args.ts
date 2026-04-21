export interface InitCommand {
  type: "init";
  endpoint?: string;
  apiKey?: string;
}

export interface RunCommand {
  type: "run";
  repo: string;
  prompt: string;
  planModel?: string;
  execModel?: string;
  maxCost?: string;
  maxTime?: string;
  maxSteps?: number;
}

export interface HelpCommand {
  type: "help";
}

export type Command = InitCommand | RunCommand | HelpCommand;

const runOptions = new Set([
  "--repo",
  "--plan-model",
  "--exec-model",
  "--max-cost",
  "--max-time",
  "--max-steps",
]);

const initOptions = new Set(["--endpoint", "--api-key"]);

export function parseCommand(argv: string[]): Command {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    return { type: "help" };
  }

  if (command === "init") return parseInit(rest);
  if (command === "run") return parseRun(rest);

  throw new Error(`Unknown command: ${command}`);
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
  }

  return parsed;
}

function parseRun(argv: string[]): RunCommand {
  const promptParts: string[] = [];
  const parsed: Partial<RunCommand> = { type: "run" };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg.startsWith("--")) {
      if (!runOptions.has(arg)) throw new Error(`Unknown option: ${arg}`);

      const value = readOptionValue(argv, index, arg);
      index++;

      switch (arg) {
        case "--repo":
          parsed.repo = value;
          break;
        case "--plan-model":
          parsed.planModel = value;
          break;
        case "--exec-model":
          parsed.execModel = value;
          break;
        case "--max-cost":
          parsed.maxCost = value;
          break;
        case "--max-time":
          parsed.maxTime = value;
          break;
        case "--max-steps":
          parsed.maxSteps = parsePositiveInteger(value, "--max-steps");
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
    planModel: parsed.planModel,
    execModel: parsed.execModel,
    maxCost: parsed.maxCost,
    maxTime: parsed.maxTime,
    maxSteps: parsed.maxSteps,
  };
}

function readOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return number;
}

export function usage(): string {
  return [
    "Usage:",
    "  codevil init [--endpoint URL] [--api-key KEY]",
    "  codevil run --repo REPO_URL [--plan-model MODEL] [--exec-model MODEL] [--max-cost COST] [--max-time TIME] [--max-steps N] <prompt>",
  ].join("\n");
}
