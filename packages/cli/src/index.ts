#!/usr/bin/env node

import { parseCommand, usage } from "./args.js";
import { createConfig, readConfig, writeConfig } from "./config.js";
import { runSession } from "./runner.js";
import { promptForText } from "./prompt.js";

async function main(argv: string[]): Promise<void> {
  const command = parseCommand(argv);

  if (command.type === "help") {
    console.log(usage());
    return;
  }

  if (command.type === "init") {
    const endpoint = command.endpoint ?? await promptForText("Worker endpoint URL: ");
    const apiKey = command.apiKey ?? await promptForText("API key: ");
    await writeConfig(createConfig(endpoint, apiKey));
    console.log("Wrote ~/.codevil/config");
    return;
  }

  const config = await readConfig();
  await runSession(config, command);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
