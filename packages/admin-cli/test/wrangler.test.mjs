import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildWranglerEnv, createWranglerClient } from "../dist/wrangler.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

test("whoami runs wrangler from the repo root with the expected args", async () => {
  const calls = [];
  const wrangler = createWranglerClient({
    exec: async (request) => {
      calls.push(request);
      return { exitCode: 0, stdout: "{\"email\":\"dev@example.com\"}", stderr: "" };
    },
  });

  await wrangler.whoami();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    command: "pnpm",
    args: ["--filter", "@codevil/worker", "exec", "wrangler", "whoami", "--json"],
    cwd: repoRoot,
    stdin: undefined,
    env: buildWranglerEnv(process.env),
  });
});

test("configuredSecrets parses secret names from wrangler JSON output", async () => {
  const wrangler = createWranglerClient({
    exec: async () => ({
      exitCode: 0,
      stdout: JSON.stringify([
        { name: "OPENAI_API_KEY", type: "secret_text" },
        { name: "OPENROUTER_API_KEY", type: "secret_text" },
      ]),
      stderr: "",
    }),
  });

  const secrets = await wrangler.configuredSecrets();

  assert.deepEqual([...secrets], ["OPENAI_API_KEY", "OPENROUTER_API_KEY"]);
});

test("uploadSecrets sends only stdin JSON and redacts submitted values from surfaced failures", async () => {
  const calls = [];
  const wrangler = createWranglerClient({
    exec: async (request) => {
      calls.push(request);
      return {
        exitCode: 1,
        stdout: "upload failed for sk-live-secret-value",
        stderr: "stderr mentions sk-live-secret-value too",
      };
    },
  });

  await assert.rejects(
    () => wrangler.uploadSecrets({ OPENAI_API_KEY: "sk-live-secret-value" }),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.match(error.message, /secret bulk/i);
      assert.doesNotMatch(error.message, /sk-live-secret-value/);
      return true;
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    command: "pnpm",
    args: ["--filter", "@codevil/worker", "exec", "wrangler", "secret", "bulk"],
    cwd: repoRoot,
    stdin: JSON.stringify({ OPENAI_API_KEY: "sk-live-secret-value" }),
    env: buildWranglerEnv(process.env),
  });
  assert.equal(calls[0].args.includes("sk-live-secret-value"), false);
  assert.equal(JSON.stringify(calls[0].env ?? {}).includes("sk-live-secret-value"), false);
});

test("configuredSecrets reports invalid wrangler output with useful diagnostics", async () => {
  const wrangler = createWranglerClient({
    exec: async () => ({
      exitCode: 0,
      stdout: "{\"unexpected\":true}",
      stderr: "plain stderr",
    }),
  });

  await assert.rejects(
    () => wrangler.configuredSecrets(),
    /Unable to parse configured wrangler secrets/,
  );
});

test("buildWranglerEnv preserves the allowlist and drops unrelated or provider secret values", () => {
  const env = buildWranglerEnv({
    PATH: "/usr/bin",
    HOME: "/Users/example",
    HTTP_PROXY: "http://proxy",
    http_proxy: "http://proxy-lower",
    CI: "1",
    CLOUDFLARE_API_TOKEN: "cf-token",
    OPENAI_API_KEY: "provider-secret",
    OPENROUTER_API_KEY: "provider-secret-2",
    RANDOM_SECRET: "nope",
  });

  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/Users/example",
    HTTP_PROXY: "http://proxy",
    http_proxy: "http://proxy-lower",
    CI: "1",
    CLOUDFLARE_API_TOKEN: "cf-token",
  });
});
