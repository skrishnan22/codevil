import assert from "node:assert/strict";
import test from "node:test";

import { parseCommand } from "../dist/args.js";

test("parses run command with repo, prompt, models, and guard options", () => {
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
    "--max-cost",
    "$5",
    "--max-time",
    "30m",
    "--max-steps",
    "75",
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
    maxCost: "$5",
    maxTime: "30m",
    maxSteps: 75,
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
    "openai",
  ]);

  assert.deepEqual(command, {
    type: "init",
    endpoint: "https://codevil.example.com/",
    apiKey: "secret",
    provider: "openai",
  });
});

test("rejects run without a repo", () => {
  assert.throws(
    () => parseCommand(["run", "do", "work"]),
    /Missing required option: --repo/,
  );
});

test("rejects unknown options", () => {
  assert.throws(
    () => parseCommand(["run", "--repo", "repo", "--wat", "do", "work"]),
    /Unknown option: --wat/,
  );
});
