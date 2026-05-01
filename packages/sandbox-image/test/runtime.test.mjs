import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SandboxRuntime,
  ShellCommandRunner,
  detectSetupCommand,
  detectVerificationCommand,
} from "../dist/runtime.js";

const zeroCost = {
  input_tokens: 0,
  output_tokens: 0,
  total_cost_usd: 0,
};

test("init clones the repo and reports clone progress", async () => {
  const sent = [];
  const git = new FakeGitDriver();
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => new FakeAgentDriver(),
    git,
  });

  await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });

  assert.deepEqual(git.calls, [
    ["clone", "https://github.com/example/app", "/workspace/repo"],
    ["defaultBranch", "/workspace/repo"],
  ]);
  assert.deepEqual(sent, [
    { type: "clone_started" },
    { type: "clone_progress", line: "Cloning https://github.com/example/app into /workspace/repo" },
    { type: "clone_complete" },
    { type: "status", message: "Repository ready on main." },
  ]);
});

test("init runs repository setup after clone", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-runtime-"));
  const sent = [];
  const git = new FakeGitDriver({ createCodevilSetup: true });
  const commandRunner = new FakeCommandRunner();
  const runtime = new SandboxRuntime({
    workspace,
    send: (message) => sent.push(message),
    agentFactory: () => new FakeAgentDriver(),
    git,
    commandRunner,
  });

  try {
    await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });

    assert.deepEqual(commandRunner.calls, [[
      "bash .codevil/setup.sh",
      join(workspace, "repo"),
      300_000,
    ]]);
    assert.deepEqual(sent.slice(-4), [
      { type: "status", message: "Running setup command: bash .codevil/setup.sh" },
      { type: "status", message: "Setup completed." },
      { type: "clone_complete" },
      { type: "status", message: "Repository ready on main." },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("detectSetupCommand prefers explicit setup script, then package manager lockfiles", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-setup-detect-"));
  try {
    await mkdir(join(workspace, ".codevil"), { recursive: true });
    await writeFile(join(workspace, ".codevil", "setup.sh"), "#!/bin/bash\n");
    await writeFile(join(workspace, "pnpm-lock.yaml"), "");

    assert.equal(detectSetupCommand(workspace), "bash .codevil/setup.sh");

    await rm(join(workspace, ".codevil"), { recursive: true, force: true });
    assert.equal(detectSetupCommand(workspace), "pnpm install --frozen-lockfile");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("detectVerificationCommand uses the detected package manager", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-verify-detect-"));
  try {
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
    }));
    await writeFile(join(workspace, "pnpm-lock.yaml"), "");

    assert.equal(detectVerificationCommand(workspace), "pnpm test");

    await rm(join(workspace, "pnpm-lock.yaml"));
    await writeFile(join(workspace, "package-lock.json"), "{}");

    assert.equal(detectVerificationCommand(workspace), "npm test");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("detectSetupCommand uses non-interactive npm install flags", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-npm-setup-detect-"));
  try {
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      scripts: { test: "node --test" },
    }));
    await writeFile(join(workspace, "package-lock.json"), "{}");

    assert.equal(detectSetupCommand(workspace), "npm install --no-audit --no-fund --prefer-offline");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("init streams setup command output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-runtime-output-"));
  const sent = [];
  const git = new FakeGitDriver({ createCodevilSetup: true });
  const commandRunner = new FakeCommandRunner({
    onRun(_command, options) {
      options.onOutput?.("installing packages\nadded 12 packages\n");
    },
  });
  const runtime = new SandboxRuntime({
    workspace,
    send: (message) => sent.push(message),
    agentFactory: () => new FakeAgentDriver(),
    git,
    commandRunner,
  });

  try {
    await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });

    assert.deepEqual(
      sent
        .filter((message) => message.type === "status" && message.message.startsWith("Setup output:"))
        .map((message) => message.message),
      [
        "Setup output: installing packages",
        "Setup output: added 12 packages",
      ],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ShellCommandRunner returns timeout failures", async () => {
  const runner = new ShellCommandRunner();
  const result = await runner.run("node -e \"setTimeout(() => {}, 1000)\"", {
    cwd: process.cwd(),
    timeoutMs: 50,
  });

  assert.equal(result.code, 124);
  assert.match(result.stderr, /timed out/);
});

test("plan starts a read-only Pi session, forwards agent events, and sends plan_ready", async () => {
  const sent = [];
  const agent = new FakeAgentDriver({
    plan: {
      plan: "## Plan\n\n1. Test",
      cost: { input_tokens: 10, output_tokens: 20, total_cost_usd: 0.03 },
    },
  });
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => agent,
    git: new FakeGitDriver(),
  });

  await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });
  await runtime.handleMessage({ type: "plan", prompt: "add rate limits", model: "planner" });

  const [startCall, planCall] = agent.calls;
  assert.equal(startCall[0], "start");
  assert.equal(startCall[1].cwd, "/workspace/repo");
  assert.equal(startCall[1].mode, "read-only");
  assert.equal(startCall[1].model, "planner");
  assert.equal(startCall[1].provider, "anthropic");
  assert.equal(startCall[1].llmKey, undefined);
  assert.equal(typeof startCall[1].onEvent, "function");
  assert.equal(planCall[0], "plan");
  assert.match(planCall[1], /You are in PLAN MODE/);
  assert.match(planCall[1], /add rate limits/);
  assert.deepEqual(sent.slice(4), [
    { type: "agent_event", event: { type: "agent_start" } },
    {
      type: "plan_ready",
      plan: "## Plan\n\n1. Test",
      cost: { input_tokens: 10, output_tokens: 20, total_cost_usd: 0.03 },
    },
  ]);
});

test("refine_plan reuses the active agent session", async () => {
  const sent = [];
  const agent = new FakeAgentDriver({
    plan: { plan: "## Plan", cost: zeroCost },
    refine: { plan: "## Revised", cost: zeroCost },
  });
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => agent,
    git: new FakeGitDriver(),
  });

  await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });
  await runtime.handleMessage({ type: "plan", prompt: "add rate limits", model: "planner" });
  await runtime.handleMessage({ type: "refine_plan", feedback: "Use Redis" });

  assert.equal(agent.calls.at(-1)[0], "refine");
  assert.match(agent.calls.at(-1)[1], /Revise the existing plan/);
  assert.match(agent.calls.at(-1)[1], /Use Redis/);
  assert.deepEqual(sent.at(-1), {
    type: "plan_ready",
    plan: "## Revised",
    cost: zeroCost,
  });
});

test("execute switches to coding tools and reports execution completion", async () => {
  const sent = [];
  const agent = new FakeAgentDriver({
    plan: { plan: "## Plan", cost: zeroCost },
    execute: { input_tokens: 100, output_tokens: 50, total_cost_usd: 0.25 },
  });
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => agent,
    git: new FakeGitDriver(),
  });

  await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });
  await runtime.handleMessage({ type: "plan", prompt: "add rate limits", model: "planner" });
  await runtime.handleMessage({ type: "execute", plan: "## Plan", model: "executor" });

  assert.deepEqual(agent.calls.at(-2), ["switchToExecution", "executor"]);
  assert.equal(agent.calls.at(-1)[0], "execute");
  assert.match(agent.calls.at(-1)[1], /Execute this approved plan/);
  assert.match(agent.calls.at(-1)[1], /Codevil will run setup and verification after you stop/);
  assert.doesNotMatch(agent.calls.at(-1)[1], /run any available tests or linters/i);
  assert.match(agent.calls.at(-1)[1], /## Plan/);
  assert.deepEqual(sent.at(-1), {
    type: "execution_complete",
    cost: { input_tokens: 100, output_tokens: 50, total_cost_usd: 0.25 },
  });
});

test("execute runs verification and retries fixes before reporting completion", async () => {
  const sent = [];
  const agent = new FakeAgentDriver({
    plan: { plan: "## Plan", cost: zeroCost },
    execute: [
      { input_tokens: 100, output_tokens: 50, total_cost_usd: 0.25 },
      { input_tokens: 30, output_tokens: 10, total_cost_usd: 0.05 },
    ],
  });
  const verifier = new FakeVerifier([
    { success: false, command: "npm test", output: "first failure" },
    { success: true, command: "npm test", output: "ok" },
  ]);
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => agent,
    git: new FakeGitDriver(),
    verifier,
  });

  await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });
  await runtime.handleMessage({ type: "plan", prompt: "add rate limits", model: "planner" });
  await runtime.handleMessage({ type: "execute", plan: "## Plan", model: "executor" });

  assert.equal(verifier.calls.length, 2);
  assert.match(agent.calls.at(-1)[1], /Verification failed after attempt 1\/5/);
  assert.deepEqual(sent.slice(-4), [
    {
      type: "verification_retrying",
      attempt: 1,
      max_attempts: 5,
      last_error: "npm test failed:\nfirst failure",
    },
    { type: "verification_started", attempt: 2, max_attempts: 5 },
    { type: "status", message: "Verification passed on attempt 2/5." },
    {
      type: "execution_complete",
      cost: { input_tokens: 130, output_tokens: 60, total_cost_usd: 0.3 },
    },
  ]);
});

test("execute reports verification_failed after five failed attempts", async () => {
  const sent = [];
  const agent = new FakeAgentDriver({
    plan: { plan: "## Plan", cost: zeroCost },
    execute: { input_tokens: 1, output_tokens: 1, total_cost_usd: 0.01 },
  });
  const verifier = new FakeVerifier(Array.from({ length: 5 }, () => ({
    success: false,
    command: "npm test",
    output: "still failing",
  })));
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => agent,
    git: new FakeGitDriver(),
    verifier,
  });

  await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });
  await runtime.handleMessage({ type: "plan", prompt: "add rate limits", model: "planner" });
  await runtime.handleMessage({ type: "execute", plan: "## Plan", model: "executor" });

  assert.equal(verifier.calls.length, 5);
  assert.deepEqual(sent.at(-2), { type: "verification_started", attempt: 5, max_attempts: 5 });
  assert.deepEqual(sent.at(-1), {
    type: "verification_failed",
    attempts: 5,
    last_error: "npm test failed:\nstill failing",
  });
});

class FakeGitDriver {
  calls = [];
  options;

  constructor(options = {}) {
    this.options = options;
  }

  async clone(repo, destination, onProgress) {
    this.calls.push(["clone", repo, destination]);
    if (this.options.createCodevilSetup) {
      await mkdir(destination, { recursive: true });
      await mkdir(join(destination, ".codevil"), { recursive: true });
      await writeFile(join(destination, ".codevil", "setup.sh"), "#!/bin/bash\n");
    }
    onProgress(`Cloning ${repo} into ${destination}`);
  }

  async defaultBranch(cwd) {
    this.calls.push(["defaultBranch", cwd]);
    return "main";
  }
}

class FakeCommandRunner {
  calls = [];
  options;

  constructor(options = {}) {
    this.options = options;
  }

  async run(command, options) {
    this.calls.push([command, options.cwd, options.timeoutMs]);
    this.options.onRun?.(command, options);
    return { code: 0, stdout: "ok", stderr: "" };
  }
}

class FakeVerifier {
  calls = [];
  results;

  constructor(results) {
    this.results = results;
  }

  async verify(cwd) {
    this.calls.push(["verify", cwd]);
    return this.results.shift();
  }
}

class FakeAgentDriver {
  calls = [];
  responses;
  onEvent;

  constructor(responses = {}) {
    this.responses = responses;
  }

  async start(options) {
    this.calls.push(["start", options]);
    this.onEvent = options.onEvent;
  }

  async plan(prompt) {
    this.calls.push(["plan", prompt]);
    this.onEvent?.({ type: "agent_start" });
    return this.responses.plan;
  }

  async refine(feedback) {
    this.calls.push(["refine", feedback]);
    return this.responses.refine;
  }

  async switchToExecution(model) {
    this.calls.push(["switchToExecution", model]);
  }

  async execute(plan) {
    this.calls.push(["execute", plan]);
    if (Array.isArray(this.responses.execute)) {
      return this.responses.execute.shift();
    }
    return this.responses.execute;
  }
}
