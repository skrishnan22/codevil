import { getModels, type KnownProvider, type Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  defineTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  AnnotationConflictSchema,
  BriefItemSchema,
  type CostInfo,
} from "@codevil/shared";

import type {
  AgentDriver,
  AgentStartOptions,
  CreatePullRequestToolOptions,
  ConsolidationInput,
  ConsolidationResult,
  PlanResult,
  TurnResult,
} from "./runtime.js";

const zeroCost: CostInfo = {
  input_tokens: 0,
  output_tokens: 0,
  total_cost_usd: 0,
};

export class PiAgentDriver implements AgentDriver {
  private session: AgentSession | undefined;
  private authStorage: AuthStorage | undefined;
  private modelRegistry: ModelRegistry | undefined;
  private latestAssistantText = "";
  private streamedAssistantText = "";

  async start(options: AgentStartOptions): Promise<void> {
    const authStorage = AuthStorage.create();
    if (options.llmKey) {
      authStorage.setRuntimeApiKey(options.provider, options.llmKey);
    }

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const provider = options.provider as KnownProvider;
    const model = modelRegistry.find(provider, options.model)
      ?? findKnownModel(provider, options.model);

    if (!model) {
      throw new Error(`Model not found: ${options.provider}/${options.model}`);
    }

    const { session } = await createAgentSession({
      cwd: options.cwd,
      model,
      authStorage,
      modelRegistry,
      customTools: [createPullRequestTool(options.createPullRequest)],
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 5 },
      }),
    });
    session.setActiveToolsByName([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
      "create_pull_request",
    ]);

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
  }

  async turn(prompt: string): Promise<TurnResult> {
    const session = this.requireSession();
    this.latestAssistantText = "";
    this.streamedAssistantText = "";
    await session.prompt(prompt);
    await waitForQueuedAgentEvents(session);
    return {
      response: this.latestAssistantText || latestAssistantText(session.messages) || this.streamedAssistantText.trim(),
      cost: zeroCost,
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
    const authStorage = AuthStorage.create();
    if (input.llmKey) {
      authStorage.setRuntimeApiKey(input.provider, input.llmKey);
    }

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const provider = input.provider as KnownProvider;
    const model = modelRegistry.find(provider, input.model)
      ?? findKnownModel(provider, input.model);

    if (!model) {
      throw new Error(`Model not found: ${input.provider}/${input.model}`);
    }

    const { session } = await createAgentSession({
      cwd: input.cwd,
      model,
      authStorage,
      modelRegistry,
      customTools: [],
      sessionManager: SessionManager.inMemory(input.cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
      }),
    });

    try {
      session.setActiveToolsByName(["read", "grep", "find", "ls"]);
      await session.prompt(consolidationPrompt(input));
      await waitForQueuedAgentEvents(session);
      const text = latestAssistantText(session.messages);
      return parseConsolidationResult(text);
    } finally {
      session.dispose();
    }
  }

  async switchToExecution(modelId: string, provider = "anthropic"): Promise<void> {
    const session = this.requireSession();
    const modelRegistry = this.modelRegistry;
    if (!modelRegistry) throw new Error("Model registry has not been initialized");

    const knownProvider = provider as KnownProvider;
    const model = modelRegistry.find(knownProvider, modelId) ?? findKnownModel(knownProvider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);

    session.setActiveToolsByName(["read", "bash", "edit", "write"]);
    await session.setModel(model);
  }

  async execute(plan: string): Promise<CostInfo> {
    const session = this.requireSession();
    await session.prompt(plan);
    return zeroCost;
  }

  dispose(): void {
    this.session?.dispose();
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("Pi session has not been started");
    return this.session;
  }
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

async function waitForQueuedAgentEvents(session: AgentSession): Promise<void> {
  const maybeQueued = (session as unknown as { _agentEventQueue?: unknown })._agentEventQueue;
  if (maybeQueued && typeof (maybeQueued as Promise<void>).then === "function") {
    await maybeQueued;
  }
}

function latestAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = assistantText(messages[index]);
    if (text) return text;
  }

  return "";
}

function consolidationPrompt(input: ConsolidationInput): string {
  return [
    "You are consolidating human feedback on a frozen markdown plan.",
    "Return only valid JSON with keys brief_items and conflicts.",
    "Merge compatible feedback into concise instructions.",
    "If two annotations contradict each other, do not choose. Emit a conflict with options.",
    "",
    "Plan markdown:",
    input.plan,
    "",
    "Open annotations JSON:",
    JSON.stringify(input.annotations),
    "",
    "Existing conflicts JSON:",
    JSON.stringify(input.conflicts),
  ].join("\n");
}

function parseConsolidationResult(text: string): ConsolidationResult {
  const parsed = JSON.parse(extractJsonObject(text));
  const briefItems = BriefItemSchema.array().parse(parsed.brief_items ?? []);
  const conflicts = AnnotationConflictSchema.array().parse(parsed.conflicts ?? []);
  return {
    brief_items: briefItems,
    conflicts,
    cost: zeroCost,
  };
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Consolidation did not return a JSON object");
  }
  return trimmed.slice(start, end + 1);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
