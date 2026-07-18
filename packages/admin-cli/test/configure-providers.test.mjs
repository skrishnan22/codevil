import assert from "node:assert/strict";
import test from "node:test";

import { configureProviders } from "../dist/configure-providers.js";
import { runCli } from "../dist/index.js";
import { PromptCancelledError } from "../dist/prompt.js";

function createPrompt({ tty = true, textAnswers = [], hiddenAnswers = [] } = {}) {
  return {
    isTTY() {
      return tty;
    },
    async text(message) {
      const answer = textAnswers.shift();
      if (answer === undefined) {
        throw new Error(`Missing fake text answer for: ${message}`);
      }
      return answer;
    },
    async hidden(message) {
      const answer = hiddenAnswers.shift();
      if (answer === undefined) {
        throw new Error(`Missing fake hidden answer for: ${message}`);
      }
      return answer;
    },
  };
}

function createOutput() {
  const entries = [];
  return {
    entries,
    log(message) {
      entries.push({ level: "log", message });
    },
    error(message) {
      entries.push({ level: "error", message });
    },
  };
}

test("configureProviders marks configured providers, supports multiple selections, and uploads only selected secrets once", async () => {
  const uploads = [];
  const validations = [];
  const output = createOutput();

  await configureProviders({
    prompt: createPrompt({
      textAnswers: ["10,1"],
      hiddenAnswers: ["openrouter-secret", "openai-secret"],
    }),
    wrangler: {
      async whoami() {},
      async configuredSecrets() {
        return new Set(["OPENAI_API_KEY"]);
      },
      async uploadSecrets(secrets) {
        uploads.push(secrets);
      },
    },
    validator: async (provider, key) => {
      validations.push({ provider: provider.displayName, key });
      return { status: "valid" };
    },
    output,
  });

  assert.deepEqual(validations, [
    { provider: "OpenRouter", key: "openrouter-secret" },
    { provider: "OpenAI", key: "openai-secret" },
  ]);
  assert.deepEqual(uploads, [
    {
      OPENROUTER_API_KEY: "openrouter-secret",
      OPENAI_API_KEY: "openai-secret",
    },
  ]);

  const transcript = output.entries.map((entry) => entry.message).join("\n");
  assert.match(transcript, /1\. OpenAI \(configured\)/);
  assert.match(transcript, /10\. OpenRouter/);
  assert.match(transcript, /OpenRouter: validated/);
  assert.match(transcript, /OpenAI: validated/);
  assert.doesNotMatch(transcript, /openrouter-secret|openai-secret/);
});

test("configureProviders rejects blank secrets and re-prompts before validating or uploading", async () => {
  const uploads = [];
  const validations = [];
  const output = createOutput();

  await configureProviders({
    prompt: createPrompt({
      textAnswers: ["1"],
      hiddenAnswers: ["", "retry-secret"],
    }),
    wrangler: {
      async whoami() {},
      async configuredSecrets() {
        return new Set();
      },
      async uploadSecrets(secrets) {
        uploads.push(secrets);
      },
    },
    validator: async (_provider, key) => {
      validations.push(key);
      return { status: "valid" };
    },
    output,
  });

  assert.deepEqual(validations, ["retry-secret"]);
  assert.deepEqual(uploads, [{ OPENAI_API_KEY: "retry-secret" }]);
  assert.match(output.entries.map((entry) => entry.message).join("\n"), /cannot be blank/i);
});

test("configureProviders stops the entire upload on invalid credentials", async () => {
  const output = createOutput();
  let uploadCount = 0;

  await assert.rejects(
    () =>
      configureProviders({
        prompt: createPrompt({
          textAnswers: ["3"],
          hiddenAnswers: ["bad-secret"],
        }),
        wrangler: {
          async whoami() {},
          async configuredSecrets() {
            return new Set();
          },
          async uploadSecrets() {
            uploadCount += 1;
          },
        },
        validator: async () => ({
          status: "invalid",
          message: "Invalid credential for OpenAI Platform.",
        }),
        output,
      }),
    /Invalid credential for OpenAI Platform\./,
  );

  assert.equal(uploadCount, 0);
  assert.doesNotMatch(
    output.entries.map((entry) => entry.message).join("\n"),
    /bad-secret/,
  );
});

test("configureProviders retries unavailable validation when requested", async () => {
  const uploads = [];
  const output = createOutput();
  let attempts = 0;

  await configureProviders({
    prompt: createPrompt({
      textAnswers: ["1", "retry"],
      hiddenAnswers: ["retry-me"],
    }),
    wrangler: {
      async whoami() {},
      async configuredSecrets() {
        return new Set();
      },
      async uploadSecrets(secrets) {
        uploads.push(secrets);
      },
    },
    validator: async () => {
      attempts += 1;
      return attempts === 1
        ? { status: "unavailable", message: "Unable to validate OpenCode Go." }
        : { status: "valid" };
    },
    output,
  });

  assert.equal(attempts, 2);
  assert.deepEqual(uploads, [{ OPENAI_API_KEY: "retry-me" }]);
  assert.match(output.entries.map((entry) => entry.message).join("\n"), /OpenAI: validated/);
});

test("configureProviders allows skipping unavailable validation but cancels upload on negative response", async () => {
  const skippedUploads = [];
  const skippedOutput = createOutput();

  await configureProviders({
    prompt: createPrompt({
      textAnswers: ["10", "skip"],
      hiddenAnswers: ["skip-secret"],
    }),
    wrangler: {
      async whoami() {},
      async configuredSecrets() {
        return new Set();
      },
      async uploadSecrets(secrets) {
        skippedUploads.push(secrets);
      },
    },
    validator: async () => ({
      status: "unavailable",
      message: "Unable to validate OpenRouter.",
    }),
    output: skippedOutput,
  });

  assert.deepEqual(skippedUploads, [{ OPENROUTER_API_KEY: "skip-secret" }]);
  assert.match(
    skippedOutput.entries.map((entry) => entry.message).join("\n"),
    /OpenRouter: skipped validation/,
  );

  let cancelledUploads = 0;

  await assert.rejects(
    () =>
      configureProviders({
        prompt: createPrompt({
        textAnswers: ["10", "no"],
          hiddenAnswers: ["cancel-secret"],
        }),
        wrangler: {
          async whoami() {},
          async configuredSecrets() {
            return new Set();
          },
          async uploadSecrets() {
            cancelledUploads += 1;
          },
        },
        validator: async () => ({
          status: "unavailable",
          message: "Unable to validate OpenRouter.",
        }),
        output: createOutput(),
      }),
    /Upload cancelled\./,
  );

  assert.equal(cancelledUploads, 0);
});

test("configureProviders re-prompts when unavailable validation decision is blank or unrecognized", async () => {
  const uploads = [];
  const output = createOutput();
  let attempts = 0;

  await configureProviders({
    prompt: createPrompt({
      textAnswers: ["1", "", "maybe", "retry", "skip"],
      hiddenAnswers: ["retry-secret"],
    }),
    wrangler: {
      async whoami() {},
      async configuredSecrets() {
        return new Set();
      },
      async uploadSecrets(secrets) {
        uploads.push(secrets);
      },
    },
    validator: async () => {
      attempts += 1;
      return attempts === 1
        ? { status: "unavailable", message: "Unable to validate OpenCode Go." }
        : { status: "unavailable", message: "Unable to validate OpenCode Go." };
    },
    output,
  });

  assert.equal(attempts, 2);
  assert.deepEqual(uploads, [{ OPENAI_API_KEY: "retry-secret" }]);
  const transcript = output.entries.map((entry) => entry.message).join("\n");
  assert.match(transcript, /Enter retry, skip, or no\/cancel/i);
  assert.match(transcript, /OpenAI: skipped validation/);
});

test("configureProviders collects required public provider configuration once without printing it", async () => {
  const uploads = [];
  const output = createOutput();

  await configureProviders({
    prompt: createPrompt({
      textAnswers: ["29", "skip", "account-id"],
      hiddenAnswers: ["cloudflare-key"],
    }),
    wrangler: {
      async whoami() {},
      async configuredSecrets() { return new Set(); },
      async uploadSecrets(secrets) { uploads.push(secrets); },
    },
    validator: async () => ({
      status: "unavailable",
      message: "Live credential validation is not available for Cloudflare Workers AI.",
    }),
    output,
  });

  assert.deepEqual(uploads, [{
    CLOUDFLARE_API_KEY: "cloudflare-key",
    CLOUDFLARE_ACCOUNT_ID: "account-id",
  }]);
  const transcript = output.entries.map((entry) => entry.message).join("\n");
  assert.doesNotMatch(transcript, /cloudflare-key|account-id/);
});

test("runCli handles help, provider setup, non-tty provider usage, unknown commands, and safe error messages", async () => {
  const helpOutput = createOutput();
  await runCli(["--help"], {
    output: helpOutput,
    setExitCode(code) {
      assert.equal(code, 0);
    },
  });
  assert.match(helpOutput.entries.map((entry) => entry.message).join("\n"), /Usage:/);

  const providerCalls = [];
  const providerOutput = createOutput();
  await runCli(["providers"], {
    prompt: createPrompt(),
    configureProviders: async () => {
      providerCalls.push("called");
    },
    output: providerOutput,
    setExitCode(code) {
      assert.equal(code, 0);
    },
  });
  assert.deepEqual(providerCalls, ["called"]);

  const nonTtyOutput = createOutput();
  let nonTtyExitCode = 0;
  await runCli(["providers"], {
    prompt: createPrompt({ tty: false }),
    output: nonTtyOutput,
    setExitCode(code) {
      nonTtyExitCode = code;
    },
  });
  assert.equal(nonTtyExitCode, 1);
  assert.match(
    nonTtyOutput.entries.map((entry) => entry.message).join("\n"),
    /interactive terminal/i,
  );
  assert.match(
    nonTtyOutput.entries.map((entry) => entry.message).join("\n"),
    /does not support key flags/i,
  );

  const unknownOutput = createOutput();
  let unknownExitCode = 0;
  await runCli(["wat"], {
    output: unknownOutput,
    setExitCode(code) {
      unknownExitCode = code;
    },
  });
  assert.equal(unknownExitCode, 1);
  assert.match(
    unknownOutput.entries.map((entry) => entry.message).join("\n"),
    /Unknown command: wat/,
  );

  const safeErrorOutput = createOutput();
  let safeErrorExitCode = 0;
  await runCli(["providers"], {
    prompt: createPrompt(),
    configureProviders: async () => {
      throw new Error("safe failure only");
    },
    output: safeErrorOutput,
    setExitCode(code) {
      safeErrorExitCode = code;
    },
  });
  assert.equal(safeErrorExitCode, 1);
  assert.match(
    safeErrorOutput.entries.map((entry) => entry.message).join("\n"),
    /safe failure only/,
  );
  assert.doesNotMatch(
    safeErrorOutput.entries.map((entry) => entry.message).join("\n"),
    /at runCli|Error:/,
  );
});

test("runCli maps prompt cancellation to exit code 130 with a concise message", async () => {
  const output = createOutput();
  let exitCode = 0;

  await runCli(["providers"], {
    prompt: createPrompt(),
    configureProviders: async () => {
      throw new PromptCancelledError();
    },
    output,
    setExitCode(code) {
      exitCode = code;
    },
  });

  assert.equal(exitCode, 130);
  assert.match(output.entries.map((entry) => entry.message).join("\n"), /Cancelled\./);
});
