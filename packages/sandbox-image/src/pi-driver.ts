import { getModels, type KnownProvider, type Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";

import type { CostInfo } from "@codevil/shared";

import type { AgentDriver, AgentStartOptions, PlanResult } from "./runtime.js";

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
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 5 },
      }),
    });
    session.setActiveToolsByName(["read", "grep", "find", "ls"]);

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

  async plan(prompt: string): Promise<PlanResult> {
    const session = this.requireSession();
    this.latestAssistantText = "";
    this.streamedAssistantText = "";
    await session.prompt(prompt);
    await waitForQueuedAgentEvents(session);
    return {
      plan: this.latestAssistantText || latestAssistantText(session.messages) || this.streamedAssistantText.trim(),
      cost: zeroCost,
    };
  }

  async refine(feedback: string): Promise<PlanResult> {
    const session = this.requireSession();
    this.latestAssistantText = "";
    this.streamedAssistantText = "";
    await session.prompt(feedback);
    await waitForQueuedAgentEvents(session);
    return {
      plan: this.latestAssistantText || latestAssistantText(session.messages) || this.streamedAssistantText.trim(),
      cost: zeroCost,
    };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
