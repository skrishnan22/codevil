#!/usr/bin/env node

import { parseCommand, usage } from "./args.js";
import { createConfig, readConfig, writeConfig } from "./config.js";
import { checkAgentRunnableModel, listAgentRunnableModels } from "./models.js";
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
    await writeConfig(createConfig(endpoint, apiKey, {
      provider: command.provider,
      planModel: command.planModel,
      execModel: command.execModel,
    }));
    console.log("Wrote ~/.codevil/config");
    return;
  }

  if (command.type === "models-list") {
    const models = listAgentRunnableModels(command.provider);
    if (models.length === 0) {
      console.log(`No runnable models for ${command.provider}.`);
      return;
    }
    for (const model of models) {
      console.log(`${model.provider}/${model.id}\t${model.name}`);
    }
    return;
  }

  if (command.type === "models-check") {
    const ok = checkAgentRunnableModel(command.provider, command.modelId);
    if (ok) {
      console.log(`ok ${command.provider}/${command.modelId}`);
      return;
    }
    console.error(`missing ${command.provider}/${command.modelId}`);
    process.exitCode = 1;
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
