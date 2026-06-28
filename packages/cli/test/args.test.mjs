import assert from "node:assert/strict";
import test from "node:test";

import { parseCommand } from "../dist/args.js";

test("parses run command with repo, prompt, models, and time guard options", () => {
  const command = parseCommand([
    "run",
    "--repo",
    "https://github.com/example/app",
    "--provider",
    "anthropic",
    "--plan-model",
    "planner",
    "--exec-model",
    "executor",
    "--max-time",
    "30m",
    "add",
    "rate",
    "limits",
  ]);

  assert.deepEqual(command, {
    type: "run",
    repo: "https://github.com/example/app",
    prompt: "add rate limits",
    provider: "anthropic",
    planModel: "planner",
    execModel: "executor",
    maxTime: "30m",
    debug: undefined,
  });
});

test("parses init command with optional non-interactive values", () => {
  const command = parseCommand([
    "init",
    "--endpoint",
    "https://codevil.example.com/",
    "--api-key",
    "secret",
    "--provider",
    "opencode-go",
    "--plan-model",
    "kimi-k2.6",
    "--exec-model",
    "kimi-k2.6",
  ]);

  assert.deepEqual(command, {
    type: "init",
    endpoint: "https://codevil.example.com/",
    apiKey: "secret",
    provider: "opencode-go",
    planModel: "kimi-k2.6",
    execModel: "kimi-k2.6",
  });
});

test("rejects run without a repo", () => {
  assert.throws(
    () => parseCommand(["run", "do", "work"]),
    /Missing required option: --repo/,
  );
});

test("rejects removed guard options", () => {
  assert.throws(
    () => parseCommand(["run", "--repo", "repo", "--max-cost", "$5", "work"]),
    /Unknown option: --max-cost/,
  );
});
