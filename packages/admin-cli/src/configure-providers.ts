import { LLM_PROVIDERS, type LLMProviderDefinition } from "@codevil/shared";

import type { CredentialValidation } from "./provider-validation.js";
import { validateProviderCredential } from "./provider-validation.js";
import { parseNumericMultiSelect, type Prompt } from "./prompt.js";
import { createTerminalPrompt } from "./prompt.js";
import { createWranglerClient, type WranglerClient } from "./wrangler.js";
import {
  createConsoleOutput,
  safeErrorMessage,
  type Output,
} from "./console-output.js";

export type { Output } from "./console-output.js";

export type ProviderValidator = (
  provider: LLMProviderDefinition,
  key: string,
) => Promise<CredentialValidation>;

type ProviderSummary = {
  displayName: string;
  status: "validated" | "skipped validation";
};

export async function configureProviders(options: {
  prompt?: Prompt;
  wrangler?: WranglerClient;
  validator?: ProviderValidator;
  output?: Output;
} = {}): Promise<void> {
  const prompt = options.prompt ?? createTerminalPrompt();
  const wrangler = options.wrangler ?? createWranglerClient();
  const validator = options.validator ?? validateProviderCredential;
  const output = options.output ?? createConsoleOutput();

  await wrangler.whoami();
  const configuredSecrets = await wrangler.configuredSecrets();

  output.log("Available providers:");
  for (const [index, provider] of LLM_PROVIDERS.entries()) {
    const suffix = configuredSecrets.has(provider.secretName) ? " (configured)" : "";
    output.log(`${index + 1}. ${provider.displayName}${suffix}`);
  }

  const selectedIndices = await promptForProviderSelection(prompt, output);
  const secretsToUpload: Record<string, string> = {};
  const credentialsBySecret = new Map<string, string>();
  const validationBySecret = new Map<string, ProviderSummary["status"]>();
  const configuredValues = new Set<string>();
  const summary: ProviderSummary[] = [];

  for (const selectedIndex of selectedIndices) {
    const provider = LLM_PROVIDERS[selectedIndex - 1];
    let key = credentialsBySecret.get(provider.secretName);
    let status = validationBySecret.get(provider.secretName);
    if (!key || !status) {
      key = await promptForSecret(prompt, output, provider);
      status = await validateSelection(prompt, output, validator, provider, key);
      credentialsBySecret.set(provider.secretName, key);
      validationBySecret.set(provider.secretName, status);
    }

    secretsToUpload[provider.secretName] = key;
    for (const configKey of provider.configKeys) {
      if (configuredValues.has(configKey)) continue;
      secretsToUpload[configKey] = await promptForPublicConfig(prompt, output, configKey, provider);
      configuredValues.add(configKey);
    }
    summary.push({
      displayName: provider.displayName,
      status,
    });
  }

  await wrangler.uploadSecrets(secretsToUpload);

  output.log("Summary:");
  for (const item of summary) {
    output.log(`${item.displayName}: ${item.status}`);
  }
}

async function promptForPublicConfig(
  prompt: Prompt,
  output: Output,
  configKey: string,
  provider: LLMProviderDefinition,
): Promise<string> {
  while (true) {
    const value = await prompt.text(`Enter ${formatConfigKey(configKey)} for ${provider.displayName}: `);
    if (value.trim().length > 0) return value.trim();
    output.error(`${formatConfigKey(configKey)} cannot be blank.`);
  }
}

function formatConfigKey(configKey: string): string {
  return configKey.toLowerCase().split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

async function promptForProviderSelection(prompt: Prompt, output: Output): Promise<number[]> {
  while (true) {
    const response = await prompt.text("Select providers by number (comma-separated): ");
    try {
      return parseNumericMultiSelect(response, LLM_PROVIDERS.length);
    } catch (error) {
      output.error(safeErrorMessage(error));
    }
  }
}

async function promptForSecret(
  prompt: Prompt,
  output: Output,
  provider: LLMProviderDefinition,
): Promise<string> {
  while (true) {
    const key = await prompt.hidden(`Enter API key for ${provider.displayName}: `);
    if (key.trim().length > 0) {
      return key;
    }

    output.error(`The ${provider.displayName} key cannot be blank.`);
  }
}

async function validateSelection(
  prompt: Prompt,
  output: Output,
  validator: ProviderValidator,
  provider: LLMProviderDefinition,
  key: string,
): Promise<ProviderSummary["status"]> {
  while (true) {
    const result = await validator(provider, key);

    if (result.status === "valid") {
      return "validated";
    }

    if (result.status === "invalid") {
      output.error(result.message);
      throw new Error(result.message);
    }

    output.error(result.message);
    while (true) {
      const decision = await prompt.text(
        `Validation unavailable for ${provider.displayName}. Type retry to validate again, skip to continue without validation, or no to cancel upload: `,
      );
      const normalizedDecision = decision.trim().toLowerCase();

      if (normalizedDecision === "retry") {
        break;
      }

      if (normalizedDecision === "skip") {
        return "skipped validation";
      }

      if (normalizedDecision === "no" || normalizedDecision === "cancel") {
        output.error("Upload cancelled.");
        throw new Error("Upload cancelled.");
      }

      output.error("Enter retry, skip, or no/cancel.");
    }
  }
}
