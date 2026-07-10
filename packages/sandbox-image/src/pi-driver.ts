import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { getModels, type KnownProvider, type Model } from "@earendil-works/pi-ai/compat";
import {
  AuthStorage,
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  type CostInfo,
  isRecord,
  type ProviderApi,
  type ProviderPublicConfig,
} from "@codevil/shared";

import {
  costFromSessionStats,
  costSinceSnapshot,
  snapshotSessionCost,
} from "./pi-cost.js";

import type {
  AgentDriver,
  AgentStartOptions,
  AskQuestionOutcome,
  AskQuestionParams,
  CreatePullRequestToolOptions,
  ConsolidationInput,
  ConsolidationResult,
  PlanResult,
  TurnResult,
} from "./runtime.js";

const DEFAULT_CODEVIL_PI_AGENT_DIR = "/opt/codevil/pi-agent";

/**
 * Pi model objects are immutable catalog entries in practice.  Copying keeps the
 * shared registry untouched while directing only this sandbox's requests through
 * the Worker credential boundary.
 */
export function resolveProviderModel(model: Model<any>, providerConfig: ProviderPublicConfig = {}): Model<any> {
  let baseUrl = model.baseUrl;
  for (const [key, value] of Object.entries(providerConfig)) {
    baseUrl = baseUrl.replaceAll(`{${key}}`, value);
  }
  if (/{CLOUDFLARE_(?:ACCOUNT|GATEWAY)_ID}/.test(baseUrl)) {
    throw new Error(`Missing provider configuration for ${model.provider}`);
  }
  return { ...model, baseUrl };
}

function withProxyModel(model: Model<any>, provider: string, proxyBase: string, sessionId: string): Model<any> {
  const original = new URL(model.baseUrl);
  const proxy = new URL(`/sandbox-proxy/sessions/${encodeURIComponent(sessionId)}/llm/${encodeURIComponent(provider)}/${encodeURIComponent(model.api)}/`, proxyBase);
  return {
    ...model,
    baseUrl: proxy.toString(),
    headers: {
      ...model.headers,
      "x-codevil-proxy-target": original.toString(),
    },
  };
}

/**
 * Pi needs these IDs in its provider-scoped API-key credential to resolve
 * Cloudflare model URLs. The key is always the short-lived proxy capability,
 * never the Worker-held provider key, and in-memory storage avoids persistence.
 */
function setSandboxCredential(
  authStorage: AuthStorage,
  provider: string,
  key: string | undefined,
  providerConfig: ProviderPublicConfig | undefined,
): void {
  if (key) {
    authStorage.set(provider, {
      type: "api_key",
      key,
      ...(providerConfig && Object.keys(providerConfig).length > 0 ? { env: providerConfig } : {}),
    });
    authStorage.setRuntimeApiKey(provider, key);
  }
}

export class PiAgentDriver implements AgentDriver {
  private session: AgentSession | undefined;
  private authStorage: AuthStorage | undefined;
  private modelRegistry: ModelRegistry | undefined;
  private proxyBase: string | undefined;
  private proxySessionId: string | undefined;
  private proxyTokens: Partial<Record<ProviderApi, string>> | undefined;
  private provider: string | undefined;
  private providerConfig: ProviderPublicConfig | undefined;
  private latestAssistantText = "";
  private streamedAssistantText = "";

  async start(options: AgentStartOptions): Promise<void> {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const provider = options.provider as KnownProvider;
    const model = modelRegistry.find(provider, options.model)
      ?? findKnownModel(provider, options.model);

    if (!model) {
      throw new Error(`Model not found: ${options.provider}/${options.model}`);
    }

    const proxyToken = options.proxyTokens?.[model.api as ProviderApi];
    if (options.proxyBase && (!proxyToken || !options.proxySessionId)) throw new Error("Missing sandbox proxy capability for model API");
    setSandboxCredential(authStorage, options.provider, proxyToken ?? options.llmKey, options.providerConfig);
    const configuredModel = resolveProviderModel(model, options.providerConfig);
    const proxiedModel = options.proxyBase ? withProxyModel(configuredModel, options.provider, options.proxyBase, options.proxySessionId!) : configuredModel;
    const customTools: ReturnType<typeof defineTool>[] = [
      createPullRequestTool(options.createPullRequest),
    ];
    if (options.askQuestion) {
      customTools.push(askQuestionTool(options.askQuestion));
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 5 },
    });
    const { agentDir, resourceLoader } = await createCodevilResourceLoader(options.cwd, settingsManager);

    const { session } = await createAgentSession({
      cwd: options.cwd,
      agentDir,
      model: proxiedModel,
      authStorage,
      modelRegistry,
      customTools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager,
    });
    const activeTools = [
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
      "create_pull_request",
    ];
    if (options.askQuestion) {
      activeTools.push("ask_question");
    }
    session.setActiveToolsByName(activeTools);

    session.subscribe((event) => {
      const delta = extractAssistantDeltaFromEvent(event);
      if (delta) this.streamedAssistantText += delta;
      const text = extractAssistantTextFromEvent(event);
      if (text) this.latestAssistantText = text;
      options.onEvent(event);
    });

    this.session = session;
    this.authStorage = authStorage;
    this.modelRegistry = modelRegistry;
    this.proxyBase = options.proxyBase;
    this.proxySessionId = options.proxySessionId;
    this.proxyTokens = options.proxyTokens;
    this.provider = options.provider;
    this.providerConfig = options.providerConfig && { ...options.providerConfig };
  }

  async turn(prompt: string): Promise<TurnResult> {
    const session = this.requireSession();
    this.latestAssistantText = "";
    this.streamedAssistantText = "";
    const before = snapshotSessionCost(session);
    await session.prompt(prompt);
    await waitForQueuedAgentEvents(session);
    const cost = costSinceSnapshot(before, snapshotSessionCost(session));
    return {
      response: this.latestAssistantText || latestAssistantText(session.messages) || this.streamedAssistantText.trim(),
      cost,
    };
  }

  async plan(prompt: string): Promise<PlanResult> {
    const result = await this.turn(prompt);
    return {
      plan: result.response,
      cost: result.cost,
    };
  }

  async refine(feedback: string): Promise<PlanResult> {
    const result = await this.turn(feedback);
    return {
      plan: result.response,
      cost: result.cost,
    };
  }

  async consolidateAnnotations(input: ConsolidationInput): Promise<ConsolidationResult> {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const provider = input.provider as KnownProvider;
    const model = modelRegistry.find(provider, input.model)
      ?? findKnownModel(provider, input.model);

    if (!model) {
      throw new Error(`Model not found: ${input.provider}/${input.model}`);
    }

    // Build the custom tools list: read-only file tools + ask_question when available.
    const proxyToken = input.proxyTokens?.[model.api as ProviderApi];
    if (input.proxyBase && (!proxyToken || !input.proxySessionId)) throw new Error("Missing sandbox proxy capability for model API");
    setSandboxCredential(authStorage, input.provider, proxyToken ?? input.llmKey, input.providerConfig);
    const configuredModel = resolveProviderModel(model, input.providerConfig);
    const proxiedModel = input.proxyBase ? withProxyModel(configuredModel, input.provider, input.proxyBase, input.proxySessionId!) : configuredModel;
    const customTools: ReturnType<typeof defineTool>[] = [];
    if (input.askQuestion) {
      customTools.push(askQuestionTool(input.askQuestion));
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });
    const { agentDir, resourceLoader } = await createCodevilResourceLoader(input.cwd, settingsManager);

    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir,
      model: proxiedModel,
      authStorage,
      modelRegistry,
      customTools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(input.cwd),
      settingsManager,
    });

    try {
      const activeTools = ["read", "grep", "find", "ls"];
      if (input.askQuestion) activeTools.push("ask_question");
      session.setActiveToolsByName(activeTools);
      await session.prompt(consolidationPrompt(input));
      await waitForQueuedAgentEvents(session);
      const brief = latestAssistantText(session.messages);
      return { brief, cost: costFromSessionStats(session) };
    } finally {
      session.dispose();
    }
  }

  async switchToExecution(modelId: string, provider = "anthropic"): Promise<void> {
    const session = this.requireSession();
    const modelRegistry = this.modelRegistry;
    if (!modelRegistry) throw new Error("Model registry has not been initialized");
    const authStorage = this.authStorage;
    if (!authStorage) throw new Error("Auth storage has not been initialized");

    const knownProvider = provider as KnownProvider;
    const model = modelRegistry.find(knownProvider, modelId) ?? findKnownModel(knownProvider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);

    const proxyToken = this.proxyTokens?.[model.api as ProviderApi];
    if (this.proxyBase && (!proxyToken || !this.proxySessionId)) {
      throw new Error("Missing sandbox proxy capability for model API");
    }
    if (proxyToken) {
      setSandboxCredential(authStorage, provider, proxyToken, this.providerConfig);
    }
    const proxiedModel = this.proxyBase
      ? withProxyModel(resolveProviderModel(model, this.providerConfig), provider, this.proxyBase, this.proxySessionId!)
      : resolveProviderModel(model, this.providerConfig);
    this.provider = provider;

    session.setActiveToolsByName(["read", "bash", "edit", "write"]);
    await session.setModel(proxiedModel);
  }

  refreshProxyCapabilities(tokens: Partial<Record<ProviderApi, string>>): void {
    this.proxyTokens = tokens;
    if (!this.authStorage || !this.provider) return;
    const token = this.session?.model?.api && tokens[this.session.model.api as ProviderApi];
    if (token) this.authStorage.setRuntimeApiKey(this.provider, token);
  }

  async execute(plan: string): Promise<CostInfo> {
    const session = this.requireSession();
    const before = snapshotSessionCost(session);
    await session.prompt(plan);
    await waitForQueuedAgentEvents(session);
    return costSinceSnapshot(before, snapshotSessionCost(session));
  }

  dispose(): void {
    this.session?.dispose();
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("Pi session has not been started");
    return this.session;
  }
}

async function createCodevilResourceLoader(
  cwd: string,
  settingsManager: SettingsManager,
): Promise<{ agentDir: string; resourceLoader: ResourceLoader }> {
  const agentDir = process.env.CODEVIL_PI_AGENT_DIR || DEFAULT_CODEVIL_PI_AGENT_DIR;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalSkillPaths: [join(agentDir, "skills")],
  });
  await resourceLoader.reload();
  return { agentDir, resourceLoader };
}

export function extractAssistantTextFromEvent(event: unknown): string {
  if (!isRecord(event) || typeof event.type !== "string") return "";

  if (event.type === "agent_end" && Array.isArray(event.messages)) {
    return latestAssistantText(event.messages);
  }

  if (
    (event.type === "turn_end" || event.type === "message_end") &&
    isRecord(event.message)
  ) {
    return assistantText(event.message);
  }

  return "";
}

export function extractAssistantDeltaFromEvent(event: unknown): string {
  if (!isRecord(event) || event.type !== "message_update") return "";

  const assistantEvent = event.assistantMessageEvent;
  if (isRecord(assistantEvent) && typeof assistantEvent.delta === "string") {
    return assistantEvent.delta;
  }

  const message = event.message;
  if (isRecord(message)) return assistantText(message);

  return "";
}

// Pi SDK keeps _agentEventQueue private on AgentSession with no public flush/await API.
// Reaching into it risks breakage on SDK upgrades; keep this guard defensive.
async function waitForQueuedAgentEvents(session: AgentSession): Promise<void> {
  const maybeQueued = (session as unknown as { _agentEventQueue?: unknown })._agentEventQueue;
  if (maybeQueued != null && typeof (maybeQueued as Promise<unknown>).then === "function") {
    try {
      await maybeQueued;
    } catch {
      // A rejected queue should not block the caller.
    }
  }
}

function latestAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = assistantText(messages[index]);
    if (text) return text;
  }

  return "";
}

export function consolidationPrompt(input: ConsolidationInput): string {
  return [
    "You are consolidating human annotations on a frozen markdown plan into a single, clear instruction set for the coding agent.",
    "",
    "Your job:",
    "1. Read all annotations. Merge compatible feedback into concise, deduped, actionable prose instructions.",
    "2. If two annotations genuinely contradict each other (e.g. one says 'use Redis', another says 'avoid Redis'), you MUST call the `ask_question` tool to let a human resolve it. Set one option per conflicting side, using the annotation id as the option `id`. Wait for the human's decision before finalising that part of the brief.",
    "3. Do NOT pick a side yourself on genuine contradictions — always call `ask_question` first.",
    "4. Once all contradictions are resolved (or there are none), output the final brief as plain prose in your message text. Do not use JSON. Do not use bullet-point headers unless they aid clarity.",
    "",
    "Each annotation has: id, anchoredQuote (the highlighted plan text), sourceLine (1-based line in the plan), authorName, comment, and replies.",
    "",
    "Plan markdown:",
    input.plan,
    "",
    "Open annotations JSON:",
    JSON.stringify(input.annotations),
  ].join("\n");
}

function assistantText(message: unknown): string {
  if (!isRecord(message)) return "";
  if (message.role !== "assistant") return "";

  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
      .join("")
      .trim();
  }

  return "";
}

function findKnownModel(provider: KnownProvider, modelId: string): Model<any> | undefined {
  return getModels(provider).find((model) => model.id === modelId);
}

function createPullRequestTool(
  createPullRequest: (options: CreatePullRequestToolOptions) => Promise<{ url: string }>,
): ToolDefinition {
  return defineTool({
    name: "create_pull_request",
    label: "Create pull request",
    description: "Commit the current repository changes, push a branch, and create a pull request. Use only when the user asks for a pull request.",
    promptSnippet: "Create a pull request when explicitly requested.",
    promptGuidelines: [
      "Use create_pull_request only when the user explicitly asks to create or open a pull request.",
      "Do not create a pull request automatically after making changes.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Pull request title" }),
      body: Type.String({ description: "Pull request description" }),
      branch: Type.Optional(Type.String({ description: "Branch name; generated when omitted" })),
      commit_message: Type.Optional(Type.String({ description: "Commit message; defaults to the pull request title" })),
      draft: Type.Optional(Type.Boolean({ description: "Whether to create a draft pull request; defaults to true" })),
    }),
    async execute(_toolCallId, params) {
      const result = await createPullRequest(params);
      return {
        content: [{ type: "text", text: `Pull request created: ${result.url}` }],
        details: result,
      };
    },
  });
}

export function askQuestionTool(
  askQuestion: (params: AskQuestionParams) => Promise<AskQuestionOutcome>,
): ToolDefinition {
  return defineTool({
    name: "ask_question",
    label: "Ask the session a question",
    description: [
      "Pose a question to the session and block until a human answers or the question is cancelled.",
      "Use this tool whenever you need human input to proceed — for example, when two participants have",
      "given contradictory feedback and you cannot determine which direction to take without guidance.",
      "The question can offer a fixed list of options (participants pick one or more) and/or allow a",
      "freeform reply. Provide stable, meaningful option ids — they are returned in the answer.",
    ].join(" "),
    promptSnippet: "Ask participants a question when human input is needed to resolve ambiguity.",
    promptGuidelines: [
      "Use ask_question when you have reached a decision point that genuinely requires human input.",
      "Do not use it for things you can resolve yourself (e.g. reading a file, searching the codebase).",
      "Keep the question concise. Use 'options' to give participants clear choices whenever possible.",
      "Option ids must be stable strings you will recognise in the answer (e.g. 'option_redis', 'option_d1').",
      "Set allow_freeform: true if a predefined list may not cover all valid answers.",
      "Set answerable_by: 'decider' when the session creator should coordinate the answer; use 'assigned' only when you also provide assigned_to.",
      "If the question is cancelled, wrap up gracefully — the human may have moved on.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask participants (max 8 000 chars)." }),
      context: Type.Optional(Type.String({ description: "Additional context to help participants answer (max 20 000 chars)." })),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({ description: "Stable, unique identifier for this option." }),
            label: Type.String({ description: "Short human-readable label." }),
            detail: Type.Optional(Type.String({ description: "Optional longer explanation of this option." })),
          }),
          { description: "Predefined choices participants can select." },
        ),
      ),
      allow_freeform: Type.Optional(Type.Boolean({ description: "Allow participants to type a free-text answer in addition to (or instead of) selecting options. Defaults to false." })),
      allow_multiple: Type.Optional(Type.Boolean({ description: "Allow participants to select more than one option. Defaults to false." })),
      answerable_by: Type.Optional(
        Type.Union(
          [Type.Literal("decider"), Type.Literal("anyone"), Type.Literal("assigned")],
          { description: "Who may answer: 'decider' (session creator), 'anyone' (any participant), or 'assigned' (assigned_to only). Defaults to 'decider'." },
        ),
      ),
      assigned_to: Type.Optional(
        Type.Object({
          id: Type.String({ description: "Participant id assigned to answer." }),
          name: Type.String({ description: "Participant display name assigned to answer." }),
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const normalizedParams: AskQuestionParams = {
        question: params.question,
        context: params.context,
        options: params.options as AskQuestionParams["options"],
        allow_freeform: params.allow_freeform ?? false,
        allow_multiple: params.allow_multiple ?? false,
        answerable_by: (params.answerable_by ?? "decider") as AskQuestionParams["answerable_by"],
        assigned_to: params.assigned_to as AskQuestionParams["assigned_to"],
      };

      const outcome = await askQuestion(normalizedParams);

      let text: string;
      if (outcome.cancelled) {
        text = `The question was cancelled. Reason: ${outcome.reason}. Please wrap up or proceed with the best available information.`;
      } else {
        const lines: string[] = [];

        if (outcome.option_ids.length > 0) {
          const optionLabels = outcome.option_ids.map((id) => {
            const match = normalizedParams.options?.find((o) => o.id === id);
            return match ? `${match.label} (id: ${id})` : id;
          });
          lines.push(`Selected option(s): ${optionLabels.join(", ")}.`);
        }

        if (outcome.freeform) {
          lines.push(`Freeform reply: ${outcome.freeform}`);
        }

        lines.push(`Answered by: ${outcome.answered_by.name} (id: ${outcome.answered_by.id}).`);
        text = lines.join("\n");
      }

      return {
        content: [{ type: "text" as const, text }],
        details: outcome as AskQuestionOutcome,
      };
    },
  });
}
