import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import { LLM_PROVIDER_CAPABILITIES, getProviderOutboundAuthPolicy } from "@codevil/shared";

import {
  PiAgentDriver,
  extractAssistantDeltaFromEvent,
  extractAssistantTextFromEvent,
  consolidationPrompt,
  resolveProviderModel,
} from "../dist/pi-driver.js";

test("Codevil outbound policy covers every model in the pinned Pi catalog", () => {
  const gaps = [];
  for (const provider of LLM_PROVIDER_CAPABILITIES) {
    for (const model of getModels(provider.id)) {
      const resolved = model.baseUrl
        .replaceAll("{CLOUDFLARE_ACCOUNT_ID}", "account")
        .replaceAll("{CLOUDFLARE_GATEWAY_ID}", "gateway");
      const hostname = new URL(resolved).hostname;
      if (!getProviderOutboundAuthPolicy(provider.id, hostname, model.api)) {
        gaps.push(`${provider.id}/${model.id}: ${model.api} at ${hostname}`);
      }
    }
  }
  assert.deepEqual(gaps, [], `Review Pi provider policy drift:\n${gaps.join("\n")}`);
});

test("extracts plan text from Pi agent_end messages", () => {
  const text = extractAssistantTextFromEvent({
    type: "agent_end",
    messages: [
      { role: "user", content: "make a plan" },
      { role: "assistant", content: [{ type: "text", text: "## Plan\n\n1. Fix UI" }] },
    ],
  });

  assert.equal(text, "## Plan\n\n1. Fix UI");
});

test("extracts plan text from Pi turn_end message", () => {
  const text = extractAssistantTextFromEvent({
    type: "turn_end",
    message: { role: "assistant", content: [{ type: "text", text: "## Revised Plan" }] },
  });

  assert.equal(text, "## Revised Plan");
});

test("extracts streamed assistant text from Pi message_update deltas", () => {
  const text = extractAssistantDeltaFromEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "## Plan\n" },
  });

  assert.equal(text, "## Plan\n");
});

test("starts with coding tools, create_pull_request, and ask_question active", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codevil-pi-driver-"));
  const driver = new PiAgentDriver();
  const createPullRequestCalls = [];

  try {
    await driver.start({
      cwd,
      mode: "coding",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      llmKey: "test-key",
      onEvent: () => {},
      createPullRequest: async (options) => {
        createPullRequestCalls.push(options);
        return { url: "https://github.com/example/app/pull/1" };
      },
      askQuestion: async () => ({
        cancelled: false,
        option_ids: ["opt_1"],
        answered_by: { id: "usr_1", name: "Alice" },
      }),
    });

    const session = driver.session;
    assert.deepEqual(session.getActiveToolNames().sort(), [
      "ask_question",
      "bash",
      "create_pull_request",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
    assert.ok(session.getAllTools().some((tool) => tool.name === "create_pull_request"));
    assert.ok(session.getAllTools().some((tool) => tool.name === "ask_question"));
  } finally {
    driver.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("starts an OpenCode Go session with Pi's maintained Kimi K2.7 Code catalog model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codevil-pi-opencode-go-"));
  const driver = new PiAgentDriver();

  try {
    await driver.start({
      cwd,
      mode: "coding",
      provider: "opencode-go",
      model: "kimi-k2.7-code",
      llmKey: "test-key",
      onEvent: () => {},
      createPullRequest: async () => ({ url: "https://github.com/example/app/pull/1" }),
    });

    assert.equal(driver.session.model?.id, "kimi-k2.7-code");
    assert.equal(driver.session.model?.provider, "opencode-go");
  } finally {
    driver.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Cloudflare Pi models resolve declared account and gateway identifiers before proxy routing", () => {
  const workersAi = getModels("cloudflare-workers-ai")[0];
  const aiGateway = getModels("cloudflare-ai-gateway")[0];

  assert.equal(
    resolveProviderModel(workersAi, { CLOUDFLARE_ACCOUNT_ID: "account_123" }).baseUrl,
    "https://api.cloudflare.com/client/v4/accounts/account_123/ai/v1",
  );
  assert.equal(
    resolveProviderModel(aiGateway, {
      CLOUDFLARE_ACCOUNT_ID: "account_123",
      CLOUDFLARE_GATEWAY_ID: "gateway_456",
    }).baseUrl,
    "https://gateway.ai.cloudflare.com/v1/account_123/gateway_456/anthropic",
  );
  assert.throws(
    () => resolveProviderModel(aiGateway, { CLOUDFLARE_ACCOUNT_ID: "account_123" }),
    /Missing provider configuration for cloudflare-ai-gateway/,
  );
});

test("Cloudflare Workers AI uses a proxy capability and resolved upstream target instead of an operator credential", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codevil-pi-cloudflare-workers-ai-"));
  const driver = new PiAgentDriver();
  const model = getModels("cloudflare-workers-ai")[0];

  try {
    await driver.start({
      cwd,
      mode: "coding",
      provider: "cloudflare-workers-ai",
      model: model.id,
      proxyBase: "https://worker.example",
      proxySessionId: "ses_cloudflare",
      proxyTokens: { "openai-completions": "short-lived-proxy-capability" },
      providerConfig: { CLOUDFLARE_ACCOUNT_ID: "account_123" },
      onEvent: () => {},
      createPullRequest: async () => ({ url: "https://github.com/example/app/pull/1" }),
    });

    assert.equal(
      driver.session.model.baseUrl,
      "https://worker.example/sandbox-proxy/sessions/ses_cloudflare/llm/cloudflare-workers-ai/openai-completions/",
    );
    assert.equal(
      driver.session.model.headers["x-codevil-proxy-target"],
      "https://api.cloudflare.com/client/v4/accounts/account_123/ai/v1",
    );
    assert.equal(await driver.authStorage.getApiKey("cloudflare-workers-ai"), "short-lived-proxy-capability");
    assert.deepEqual(await driver.authStorage.getProviderEnv("cloudflare-workers-ai"), {
      CLOUDFLARE_ACCOUNT_ID: "account_123",
    });
  } finally {
    driver.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Cloudflare AI Gateway uses a proxy capability and its resolved account/gateway target", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codevil-pi-cloudflare-gateway-"));
  const driver = new PiAgentDriver();
  const model = getModels("cloudflare-ai-gateway")[0];

  try {
    await driver.start({
      cwd,
      mode: "coding",
      provider: "cloudflare-ai-gateway",
      model: model.id,
      proxyBase: "https://worker.example",
      proxySessionId: "ses_cloudflare_gateway",
      proxyTokens: { "anthropic-messages": "short-lived-gateway-capability" },
      providerConfig: {
        CLOUDFLARE_ACCOUNT_ID: "account_123",
        CLOUDFLARE_GATEWAY_ID: "gateway_456",
      },
      onEvent: () => {},
      createPullRequest: async () => ({ url: "https://github.com/example/app/pull/1" }),
    });

    assert.equal(
      driver.session.model.baseUrl,
      "https://worker.example/sandbox-proxy/sessions/ses_cloudflare_gateway/llm/cloudflare-ai-gateway/anthropic-messages/",
    );
    assert.equal(
      driver.session.model.headers["x-codevil-proxy-target"],
      "https://gateway.ai.cloudflare.com/v1/account_123/gateway_456/anthropic",
    );
    assert.equal(await driver.authStorage.getApiKey("cloudflare-ai-gateway"), "short-lived-gateway-capability");
    assert.deepEqual(await driver.authStorage.getProviderEnv("cloudflare-ai-gateway"), {
      CLOUDFLARE_ACCOUNT_ID: "account_123",
      CLOUDFLARE_GATEWAY_ID: "gateway_456",
    });
  } finally {
    driver.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("switchToExecution preserves the Pi provider target and refreshes the selected API capability", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codevil-pi-proxy-switch-"));
  const driver = new PiAgentDriver();
  try {
    await driver.start({
      cwd,
      mode: "coding",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      proxyBase: "https://worker.example/base",
      proxySessionId: "ses_proxy_test",
      proxyTokens: { "anthropic-messages": "initial-capability" },
      onEvent: () => {},
      createPullRequest: async () => ({ url: "https://github.com/example/app/pull/1" }),
    });

    driver.refreshProxyCapabilities({ "anthropic-messages": "renewed-capability" });
    await driver.switchToExecution("claude-haiku-4-5", "anthropic");

    const model = driver.session.model;
    assert.equal(model.baseUrl, "https://worker.example/sandbox-proxy/sessions/ses_proxy_test/llm/anthropic/anthropic-messages/");
    assert.equal(model.headers["x-codevil-proxy-target"], "https://api.anthropic.com/");
    assert.equal(driver.authStorage.runtimeOverrides.get("anthropic"), "renewed-capability");
  } finally {
    driver.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("switchToExecution retains Cloudflare provider configuration while rebuilding its proxy target", async () => {
  const cases = [
    {
      provider: "cloudflare-workers-ai",
      api: "openai-completions",
      config: { CLOUDFLARE_ACCOUNT_ID: "account_123" },
      target: "https://api.cloudflare.com/client/v4/accounts/account_123/ai/v1",
    },
    {
      provider: "cloudflare-ai-gateway",
      api: "anthropic-messages",
      config: { CLOUDFLARE_ACCOUNT_ID: "account_123", CLOUDFLARE_GATEWAY_ID: "gateway_456" },
      target: "https://gateway.ai.cloudflare.com/v1/account_123/gateway_456/anthropic",
    },
  ];

  for (const scenario of cases) {
    const cwd = await mkdtemp(join(tmpdir(), `codevil-pi-${scenario.provider}-switch-`));
    const driver = new PiAgentDriver();
    const model = getModels(scenario.provider)[0];
    try {
      await driver.start({
        cwd,
        mode: "coding",
        provider: scenario.provider,
        model: model.id,
        proxyBase: "https://worker.example",
        proxySessionId: "ses_cloudflare_switch",
        proxyTokens: { [scenario.api]: "initial-capability" },
        providerConfig: scenario.config,
        onEvent: () => {},
        createPullRequest: async () => ({ url: "https://github.com/example/app/pull/1" }),
      });

      driver.refreshProxyCapabilities({ [scenario.api]: "renewed-capability" });
      await driver.switchToExecution(model.id, scenario.provider);

      assert.equal(
        driver.session.model.baseUrl,
        `https://worker.example/sandbox-proxy/sessions/ses_cloudflare_switch/llm/${scenario.provider}/${scenario.api}/`,
      );
      assert.equal(driver.session.model.headers["x-codevil-proxy-target"], scenario.target);
      assert.deepEqual(await driver.authStorage.getProviderEnv(scenario.provider), scenario.config);
      assert.equal(await driver.authStorage.getApiKey(scenario.provider), "renewed-capability");
    } finally {
      driver.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("starts with Codevil sandbox skills loaded from the agent directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codevil-pi-driver-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "codevil-pi-agent-"));
  const skillDir = join(agentDir, "skills", "codevil-test-skill");
  const previousAgentDir = process.env.CODEVIL_PI_AGENT_DIR;
  const driver = new PiAgentDriver();

  try {
    process.env.CODEVIL_PI_AGENT_DIR = agentDir;
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: codevil-test-skill",
        "description: Loaded by the Codevil sandbox driver test.",
        "---",
        "",
        "Use this test skill only to prove sandbox skill discovery is wired.",
      ].join("\n"),
    );

    await driver.start({
      cwd,
      mode: "coding",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      llmKey: "test-key",
      onEvent: () => {},
      createPullRequest: async () => ({ url: "https://github.com/example/app/pull/1" }),
    });

    const names = driver.session.resourceLoader.getSkills().skills.map((skill) => skill.name);
    assert.ok(names.includes("codevil-test-skill"), `loaded skills: ${names.join(", ")}`);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.CODEVIL_PI_AGENT_DIR;
    } else {
      process.env.CODEVIL_PI_AGENT_DIR = previousAgentDir;
    }
    driver.dispose();
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

// --- consolidationPrompt (new prose-brief model) ---

test("consolidationPrompt instructs the agent to output prose (not JSON)", () => {
  const prompt = consolidationPrompt({
    cwd: "/tmp/repo",
    run_id: "run_1",
    round: 0,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    plan: "## Plan\n1. Build the thing",
    annotations: [
      { id: "ann_1", anchoredQuote: "Build", sourceLine: 1, authorName: "Alice", comment: "Use D1", replies: [] },
    ],
  });
  // Must tell the agent to emit prose, not JSON
  assert.ok(prompt.includes("plain prose") || prompt.includes("message text"), `prompt should mention prose output, got:\n${prompt}`);
  // Must NOT say "Return ONLY valid JSON" (old model)
  assert.ok(!prompt.includes("Return ONLY valid JSON"), "prompt must not instruct JSON output");
  // Must include the plan content
  assert.ok(prompt.includes("## Plan"), "prompt must include the plan markdown");
  // Must include annotations
  assert.ok(prompt.includes("ann_1"), "prompt must include annotation id");
  assert.ok(prompt.includes("Use D1"), "prompt must include annotation comment text");
});

test("consolidationPrompt instructs use of ask_question on contradictions", () => {
  const prompt = consolidationPrompt({
    cwd: "/tmp/repo",
    run_id: "run_2",
    round: 1,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    plan: "## Plan",
    annotations: [
      { id: "ann_a", anchoredQuote: "storage", sourceLine: 2, authorName: "Bob", comment: "Use Redis", replies: [] },
      { id: "ann_b", anchoredQuote: "storage", sourceLine: 2, authorName: "Carol", comment: "Avoid Redis", replies: [] },
    ],
  });
  // Must mention ask_question tool
  assert.ok(prompt.includes("ask_question"), "prompt must instruct use of the ask_question tool on contradictions");
  // Must not instruct the agent to pick a side
  assert.ok(!prompt.includes("do not choose — emit a conflict"), "old conflict-emit instruction must not appear");
});

test("consolidationPrompt includes both annotations in the prompt body", () => {
  const ann1 = { id: "ann_x", anchoredQuote: "cache", sourceLine: 5, authorName: "Dave", comment: "Use Memcached", replies: [] };
  const ann2 = { id: "ann_y", anchoredQuote: "cache", sourceLine: 5, authorName: "Eve", comment: "Use Redis", replies: [] };
  const prompt = consolidationPrompt({
    cwd: "/tmp/repo",
    run_id: "run_3",
    round: 0,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    plan: "# My Plan",
    annotations: [ann1, ann2],
  });
  assert.ok(prompt.includes("ann_x"), "prompt must include ann_x id");
  assert.ok(prompt.includes("ann_y"), "prompt must include ann_y id");
  assert.ok(prompt.includes("Memcached"), "prompt must include ann_x comment");
  assert.ok(prompt.includes("Redis"), "prompt must include ann_y comment");
});
