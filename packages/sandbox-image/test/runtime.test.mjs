import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SandboxRuntime,
  ShellCommandRunner,
  detectPreviewApps,
  detectPreviewCommand,
  detectSetupCommand,
  detectVerificationCommand,
  parsePreviewDiscovery,
  parsePreviewSuggestion,
} from "../dist/runtime.js";
import { createSandboxMessageDispatcher } from "../dist/entrypoint.js";
import { PreviewManager } from "../dist/preview-manager.js";

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
    credentialTimeoutMs: 0,
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
    { type: "preview_apps", apps: [] },
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
    credentialTimeoutMs: 0,
  });

  try {
    await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });

    assert.deepEqual(commandRunner.calls, [[
      "bash .codevil/setup.sh",
      join(workspace, "repo"),
      300_000,
    ]]);
    assert.deepEqual(sent.slice(-5), [
      { type: "status", message: "Running setup command: bash .codevil/setup.sh" },
      { type: "status", message: "Setup completed." },
      { type: "clone_complete" },
      { type: "status", message: "Repository ready on main." },
      { type: "preview_apps", apps: [] },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("init uses credential_response for authenticated GitHub clone", async () => {
  const sent = [];
  const git = new FakeGitDriver();
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => new FakeAgentDriver(),
    git,
  });

  const init = runtime.handleMessage({ type: "init", repo: "https://github.com/example/app.git" });
  await new Promise((resolve) => setImmediate(resolve));

  const request = sent.find((message) => message.type === "credential_request");
  assert.equal(request.host, "github.com");
  assert.equal(request.path, "example/app.git");

  await runtime.handleMessage({
    type: "credential_response",
    request_id: request.request_id,
    username: "x-access-token",
    password: "ghp_secret",
  });
  await init;

  assert.deepEqual(git.calls[0], [
    "clone",
    "https://github.com/example/app.git",
    "/workspace/repo",
    { username: "x-access-token", password: "ghp_secret" },
  ]);
});

test("consolidate_annotations uses a fresh agent and emits structured result", async () => {
  const sent = [];
  const git = new FakeGitDriver();
  const agents = [];
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => {
      const agent = new FakeAgentDriver({
        consolidation: {
          brief_items: [
            { instruction: "Use D1-backed storage.", source_thread_ids: ["ann_1"] },
          ],
          conflicts: [],
        },
      });
      agents.push(agent);
      return agent;
    },
    git,
    credentialTimeoutMs: 0,
  });

  await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });
  sent.length = 0;

  await runtime.handleMessage({
    type: "consolidate_annotations",
    run_id: "run_1",
    round: 0,
    plan_revision_id: "run_1:0",
    plan: "## Plan",
    annotations: [
      {
        id: "ann_1",
        run_id: "run_1",
        round: 0,
        anchor: { quote: "Redis", prefix: "Use", suffix: "for storage", startOffset: 4, endOffset: 9 },
        author: { id: "usr_1", name: "Alice" },
        comment: "Use D1-backed storage.",
        status: "open",
        created_at: "2026-06-12T00:00:00.000Z",
      },
    ],
    conflicts: [],
    model: "claude-sonnet-4-6",
  });

  assert.deepEqual(sent, [{
    type: "consolidation_complete",
    run_id: "run_1",
    round: 0,
    brief_items: [
      { instruction: "Use D1-backed storage.", source_thread_ids: ["ann_1"] },
    ],
    conflicts: [],
    cost: zeroCost,
  }]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].calls[0][0], "consolidateAnnotations");
  assert.deepEqual(agents[0].disposed, true);
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

test("detectPreviewCommand prefers Vite dev scripts and port 5173", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-preview-vite-"));
  try {
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      scripts: { dev: "vite --host 0.0.0.0" },
      devDependencies: { vite: "^5.0.0" },
    }));
    await writeFile(join(workspace, "pnpm-lock.yaml"), "");

    assert.deepEqual(detectPreviewCommand(workspace), {
      command: "pnpm dev -- --host 0.0.0.0 --port 5173",
      port: 5173,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("detectPreviewApps walks workspace packages and skips the root in monorepos", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-preview-monorepo-"));
  try {
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      name: "viz-notes-d2",
      private: true,
      workspaces: ["apps/*"],
      scripts: { dev: "npm run dev:web" },
      devDependencies: { vite: "^7.0.0" },
    }));

    await mkdir(join(workspace, "apps", "web"), { recursive: true });
    await writeFile(join(workspace, "apps", "web", "package.json"), JSON.stringify({
      name: "web",
      scripts: { dev: "next dev" },
      dependencies: { next: "^16.0.0" },
    }));

    await mkdir(join(workspace, "apps", "landing"), { recursive: true });
    await writeFile(join(workspace, "apps", "landing", "package.json"), JSON.stringify({
      name: "landing",
      scripts: { dev: "next dev" },
      dependencies: { next: "^16.0.0" },
    }));

    await mkdir(join(workspace, "apps", "hero-video"), { recursive: true });
    await writeFile(join(workspace, "apps", "hero-video", "package.json"), JSON.stringify({
      name: "hero-video",
    }));

    const apps = detectPreviewApps(workspace);
    const keys = apps.map((app) => app.key).sort();
    assert.deepEqual(keys, ["apps/landing", "apps/web"]);

    const landing = apps.find((app) => app.key === "apps/landing");
    assert.equal(landing.framework, "next");
    assert.equal(landing.port, 3001);
    assert.equal(landing.command, "npm run dev -- --hostname 0.0.0.0 --port 3001");

    // Root package's dev script must not produce a separate app entry.
    assert.ok(!apps.some((app) => app.cwd === workspace));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("detectPreviewApps reads pnpm-workspace.yaml packages", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-preview-pnpm-monorepo-"));
  try {
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "root", private: true }));
    await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");

    await mkdir(join(workspace, "apps", "web"), { recursive: true });
    await writeFile(join(workspace, "apps", "web", "package.json"), JSON.stringify({
      name: "web",
      scripts: { dev: "vite" },
      devDependencies: { vite: "^5.0.0" },
    }));

    const apps = detectPreviewApps(workspace);
    assert.equal(apps.length, 1);
    assert.equal(apps[0].framework, "vite");
    assert.equal(apps[0].key, "apps/web");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("detectPreviewCommand remaps Next.js away from port 3000", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-preview-next-"));
  try {
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      scripts: { dev: "next dev" },
      dependencies: { next: "^15.0.0" },
    }));

    assert.deepEqual(detectPreviewCommand(workspace), {
      command: "npm run dev -- --hostname 0.0.0.0 --port 3001",
      port: 3001,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("preview_start before repository initialization reports preview_error", async () => {
  const sent = [];
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => new FakeAgentDriver(),
    git: new FakeGitDriver(),
    credentialTimeoutMs: 0,
  });

  await runtime.handleMessage({ type: "preview_start", model: "planner" });

  assert.deepEqual(sent, [
    { type: "preview_error", message: "Repository is not ready for preview yet." },
  ]);
});

test("sandbox dispatcher lets preview messages bypass blocked main work", async () => {
  const calls = [];
  let releasePlan;
  const runtime = {
    async handleMessage(message) {
      calls.push(message.type);
      if (message.type === "plan") {
        await new Promise((resolve) => {
          releasePlan = resolve;
        });
      }
    },
  };
  const dispatch = createSandboxMessageDispatcher(runtime);

  dispatch({ type: "plan", prompt: "slow", model: "planner" });
  await new Promise((resolve) => setImmediate(resolve));
  dispatch({ type: "preview_start", model: "planner" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["plan", "preview_start"]);

  releasePlan();
  await new Promise((resolve) => setImmediate(resolve));
});

test("sandbox dispatcher lets create_pr_response resolve a tool call during an active turn", async () => {
  const calls = [];
  let releaseTurn;
  const runtime = {
    async handleMessage(message) {
      calls.push(message.type);
      if (message.type === "agent_turn") {
        await new Promise((resolve) => {
          releaseTurn = resolve;
        });
      }
      if (message.type === "create_pr_response") {
        releaseTurn();
      }
    },
  };
  const dispatch = createSandboxMessageDispatcher(runtime);

  dispatch({ type: "agent_turn", run_id: "run_1", prompt: "open a PR", model: "coder" });
  await new Promise((resolve) => setImmediate(resolve));
  dispatch({ type: "create_pr_response", request_id: "pr_1", url: "https://github.com/acme/app/pull/1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["agent_turn", "create_pr_response"]);
});

test("PreviewManager includes recent process output when startup times out", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-preview-timeout-"));
  const errors = [];
  const logs = [];
  const manager = new PreviewManager({
    cwd: workspace,
    readinessTimeoutMs: 50,
    onStarting() {},
    onReady() {},
    onStopped() {},
    onLog: (line) => logs.push(line),
    onError: (message) => errors.push(message),
  });

  try {
    await manager.start({
      command: "node -e \"console.error('missing env key'); setTimeout(() => {}, 1000)\"",
      port: 59999,
    });

    assert.deepEqual(logs, ["missing env key"]);
    assert.match(errors[0], /Preview server did not become healthy on port 59999/);
    assert.match(errors[0], /Recent preview output:/);
    assert.match(errors[0], /missing env key/);
  } finally {
    await manager.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("PreviewManager treats an accepted TCP connection as ready", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-preview-tcp-ready-"));
  const ready = [];
  const errors = [];
  const manager = new PreviewManager({
    cwd: workspace,
    readinessTimeoutMs: 1_000,
    onStarting() {},
    onReady: (command) => ready.push(command),
    onStopped() {},
    onError: (message) => errors.push(message),
  });

  try {
    await manager.start({
      command: "node -e \"require('net').createServer(() => {}).listen(59998, '127.0.0.1')\"",
      port: 59998,
    });

    assert.equal(errors.length, 0);
    assert.equal(ready.length, 1);
  } finally {
    await manager.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("parsePreviewDiscovery accepts fenced JSON with cwd, command, and port", () => {
  assert.deepEqual(parsePreviewDiscovery([
    "```json",
    "{\"cwd\":\"packages/web\",\"command\":\"pnpm dev -- --host 0.0.0.0 --port 5173\",\"port\":5173}",
    "```",
  ].join("\n")), {
    cwd: "packages/web",
    command: "pnpm dev -- --host 0.0.0.0 --port 5173",
    port: 5173,
  });
});

test("parsePreviewDiscovery rejects reserved port 3000", () => {
  assert.equal(parsePreviewDiscovery("{\"cwd\":\".\",\"command\":\"pnpm dev\",\"port\":3000}"), undefined);
});

test("parsePreviewSuggestion finds preview JSON after unrelated fenced content", () => {
  assert.deepEqual(parsePreviewSuggestion([
    "## Plan",
    "```json",
    "{\"unrelated\":true}",
    "```",
    "```json",
    "{\"preview\":{\"cwd\":\"apps/landing\",\"command\":\"npm run dev:landing -- --hostname 0.0.0.0 --port 5173\",\"port\":5173}}",
    "```",
  ].join("\n")), {
    cwd: "apps/landing",
    command: "npm run dev:landing -- --hostname 0.0.0.0 --port 5173",
    port: 5173,
  });
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
    credentialTimeoutMs: 0,
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

test("agent_turn starts a coding Pi session, forwards events, and sends the final response", async () => {
  const sent = [];
  const agent = new FakeAgentDriver({
    turn: {
      response: "The rate limiter is configured in src/rate-limit.ts.",
      cost: { input_tokens: 10, output_tokens: 20, total_cost_usd: 0.03 },
    },
  });
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => agent,
    git: new FakeGitDriver(),
    credentialTimeoutMs: 0,
  });

  await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });
  await runtime.handleMessage({ type: "agent_turn", run_id: "run_1", prompt: "where are rate limits configured?", model: "coder" });

  const [startCall, turnCall] = agent.calls;
  assert.equal(startCall[0], "start");
  assert.equal(startCall[1].cwd, "/workspace/repo");
  assert.equal(startCall[1].mode, "coding");
  assert.equal(startCall[1].model, "coder");
  assert.equal(startCall[1].provider, "anthropic");
  assert.equal(startCall[1].llmKey, undefined);
  assert.equal(typeof startCall[1].onEvent, "function");
  assert.equal(typeof startCall[1].createPullRequest, "function");
  assert.deepEqual(turnCall, ["turn", "where are rate limits configured?"]);
  assert.deepEqual(sent.slice(5), [
    { type: "agent_event", event: { type: "agent_start" } },
    {
      type: "agent_turn_complete",
      run_id: "run_1",
      response: "The rate limiter is configured in src/rate-limit.ts.",
      cost: { input_tokens: 10, output_tokens: 20, total_cost_usd: 0.03 },
    },
  ]);
});

test("agent_turn reuses the active Pi session for follow-up questions", async () => {
  const sent = [];
  const agent = new FakeAgentDriver({
    turn: [
      { response: "First answer", cost: zeroCost },
      { response: "Follow-up answer", cost: zeroCost },
    ],
  });
  let createdAgents = 0;
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => {
      createdAgents++;
      return agent;
    },
    git: new FakeGitDriver(),
    credentialTimeoutMs: 0,
  });

  await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });
  await runtime.handleMessage({ type: "agent_turn", run_id: "run_1", prompt: "explain auth", model: "coder" });
  await runtime.handleMessage({ type: "agent_turn", run_id: "run_2", prompt: "what calls it?", model: "coder" });

  assert.equal(createdAgents, 1);
  assert.deepEqual(agent.calls.filter(([name]) => name === "turn"), [
    ["turn", "explain auth"],
    ["turn", "what calls it?"],
  ]);
});

test("create_pull_request callback pushes and waits for the worker PR response", async () => {
  const sent = [];
  const git = new FakeGitDriver();
  let finishTurn;
  const agent = new FakeAgentDriver({
    turn: new Promise((resolve) => {
      finishTurn = resolve;
    }),
  });
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => agent,
    git,
    credentialTimeoutMs: 0,
  });

  await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });
  const turn = runtime.handleMessage({ type: "agent_turn", run_id: "run_1", prompt: "fix it and open a PR", model: "coder" });
  await new Promise((resolve) => setImmediate(resolve));

  const createPr = agent.calls.find(([name]) => name === "start")[1].createPullRequest;
  const pending = createPr({
    title: "Fix bug",
    body: "Fixes the bug",
    branch: "codevil/fix-bug",
    commit_message: "Fix bug",
    draft: true,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const request = sent.find((message) => message.type === "create_pr_request");
  assert.equal(request.run_id, "run_1");
  assert.equal(request.branch, "codevil/fix-bug");
  await runtime.handleMessage({ type: "create_pr_response", request_id: request.request_id, url: "https://github.com/example/app/pull/1" });

  assert.deepEqual(await pending, { url: "https://github.com/example/app/pull/1" });
  finishTurn({ response: "Opened PR", cost: zeroCost });
  await turn;
});

test("plan captures a preview command suggested by the main agent", async () => {
  const sent = [];
  const agent = new FakeAgentDriver({
    plan: {
      plan: [
        "## Plan",
        "",
        "```json",
        "{\"preview\":{\"cwd\":\"apps/landing\",\"command\":\"npx next dev -p 5173 -H 0.0.0.0\",\"port\":5173}}",
        "```",
      ].join("\n"),
      cost: zeroCost,
    },
  });
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => agent,
    git: new FakeGitDriver(),
    credentialTimeoutMs: 0,
  });

  await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });
  await runtime.handleMessage({ type: "plan", prompt: "work on landing page", model: "planner" });

  assert.deepEqual(sent.at(-2), {
    type: "status",
    message: "Preview command saved: npx next dev -p 5173 -H 0.0.0.0 in apps/landing on port 5173.",
  });
  assert.equal(sent.at(-1).type, "plan_ready");
});

test("preview_start uses the cached main-agent preview command without a discovery agent", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codevil-cached-preview-"));
  const sent = [];
  let createdAgents = 0;
  const planningAgent = new FakeAgentDriver({
    plan: {
      plan: [
        "## Plan",
        "",
        "{\"preview\":{\"cwd\":\".\",\"command\":\"node -e \\\"require('net').createServer(() => {}).listen(59997, '127.0.0.1')\\\"\",\"port\":59997}}",
      ].join("\n"),
      cost: zeroCost,
    },
  });
  const runtime = new SandboxRuntime({
    workspace,
    send: (message) => sent.push(message),
    agentFactory: () => {
      createdAgents += 1;
      if (createdAgents > 1) throw new Error("preview_start should not create a discovery agent");
      return planningAgent;
    },
    git: new FakeGitDriver(),
    credentialTimeoutMs: 0,
  });

  try {
    await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });
    await runtime.handleMessage({ type: "plan", prompt: "work on landing page", model: "planner" });
    await runtime.handleMessage({ type: "preview_start", model: "planner" });

    assert.equal(createdAgents, 1);
    assert.deepEqual(sent.at(-1), {
      type: "preview_ready",
      command: "node -e \"require('net').createServer(() => {}).listen(59997, '127.0.0.1')\"",
      port: 59997,
    });

    await runtime.handleMessage({ type: "preview_stop" });
  } finally {
    await runtime.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
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
    credentialTimeoutMs: 0,
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
    credentialTimeoutMs: 0,
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
    credentialTimeoutMs: 0,
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
    credentialTimeoutMs: 0,
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

test("create_pr pushes a branch and reports branch_pushed for DO-owned PR creation", async () => {
  const sent = [];
  const git = new FakeGitDriver();
  const runtime = new SandboxRuntime({
    workspace: "/workspace",
    send: (message) => sent.push(message),
    agentFactory: () => new FakeAgentDriver(),
    git,
    credentialTimeoutMs: 0,
  });

  await runtime.handleMessage({ type: "init", repo: "https://github.com/example/app" });
  await runtime.handleMessage({
    type: "create_pr",
    branch: "codevil/change",
    commit_message: "Implement change",
    pr_title: "Change",
    pr_body: "Plan",
  });

  assert.deepEqual(git.calls.slice(-1), [[
    "pushBranch",
    "/workspace/repo",
    "codevil/change",
    "Implement change",
  ]]);
  assert.deepEqual(sent.at(-1), {
    type: "branch_pushed",
    branch: "codevil/change",
    base_branch: "main",
    pr_title: "Change",
    pr_body: "Plan",
  });
});

class FakeGitDriver {
  calls = [];
  options;

  constructor(options = {}) {
    this.options = options;
  }

  async clone(repo, destination, onProgress, credential) {
    this.calls.push(credential ? ["clone", repo, destination, credential] : ["clone", repo, destination]);
    await mkdir(destination, { recursive: true }).catch(() => {});
    if (this.options.createCodevilSetup) {
      await mkdir(join(destination, ".codevil"), { recursive: true });
      await writeFile(join(destination, ".codevil", "setup.sh"), "#!/bin/bash\n");
    }
    onProgress(`Cloning ${repo} into ${destination}`);
  }

  async defaultBranch(cwd) {
    this.calls.push(["defaultBranch", cwd]);
    return "main";
  }

  async pushBranch(options) {
    this.calls.push(["pushBranch", options.cwd, options.branch, options.commitMessage]);
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
  disposed = false;

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

  async turn(prompt) {
    this.calls.push(["turn", prompt]);
    this.onEvent?.({ type: "agent_start" });
    if (Array.isArray(this.responses.turn)) return this.responses.turn.shift();
    return this.responses.turn;
  }

  async refine(feedback) {
    this.calls.push(["refine", feedback]);
    return this.responses.refine;
  }

  async consolidateAnnotations(input) {
    this.calls.push(["consolidateAnnotations", input]);
    return this.responses.consolidation;
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

  dispose() {
    this.disposed = true;
  }
}
