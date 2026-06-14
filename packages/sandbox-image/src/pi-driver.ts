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
  AskQuestionOutcome,
  AskQuestionParams,
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
      return parseConsolidationResult(text, input.run_id, input.round);
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
    "Merge compatible feedback into concise, actionable instructions.",
    "If two annotations contradict each other, do not choose — emit a conflict with options.",
    "Each annotation has: id, anchoredQuote (the highlighted text), sourceLine (1-based line), authorName, comment, and replies.",
    "",
    "Return ONLY valid JSON — no prose, no markdown fences — with exactly this shape:",
    "{",
    '  "brief_items": [',
    '    { "instruction": "<concise actionable instruction>", "source_thread_ids": ["<annotation id this came from>", "..."] }',
    "  ],",
    '  "conflicts": [',
    '    { "summary": "<what the disagreement is>", "options": [ { "thread_id": "<annotation id>", "gist": "<short label>" }, { "thread_id": "...", "gist": "..." } ] }',
    "  ]",
    "}",
    "",
    "Rules:",
    "- Each brief_items entry MUST be an object with keys 'instruction' (string) and 'source_thread_ids' (array of annotation id strings). NEVER a plain string.",
    "- Each conflicts entry provides ONLY 'summary' (string) and 'options' (array of at least two {thread_id, gist} objects). Do NOT include id, run_id, round, or status — the system fills those.",
    "- If there are no conflicts, emit an empty array for conflicts.",
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

/**
 * Normalize raw LLM brief_items output into valid BriefItem objects.
 * Strings are coerced to { instruction, source_thread_ids: [] }.
 * Objects with missing/null fields get safe defaults.
 * Entries with empty instruction after trim are dropped.
 */
export function normalizeBriefItems(raw: unknown): Array<{ instruction: string; source_thread_ids: string[] }> {
  if (!Array.isArray(raw)) return [];
  const result: Array<{ instruction: string; source_thread_ids: string[] }> = [];
  for (const entry of raw) {
    let instruction: string;
    let source_thread_ids: string[];
    if (typeof entry === "string") {
      instruction = entry.trim();
      source_thread_ids = [];
    } else if (isRecord(entry)) {
      instruction = String(entry.instruction ?? entry.text ?? "").trim();
      source_thread_ids = Array.isArray(entry.source_thread_ids)
        ? entry.source_thread_ids.filter((x): x is string => typeof x === "string")
        : [];
    } else {
      continue;
    }
    if (!instruction) continue;
    result.push({ instruction, source_thread_ids });
  }
  return result;
}

/**
 * Normalize raw LLM conflicts output into valid AnnotationConflict objects.
 * The system synthesizes id, run_id, round, and status — the LLM provides only summary + options.
 * Conflicts with fewer than 2 valid options or empty summary are dropped.
 */
export function normalizeConflicts(
  raw: unknown,
  runId: string,
  round: number,
): Array<{ id: string; run_id: string; round: number; summary: string; options: Array<{ thread_id: string; gist: string }>; status: "open" }> {
  if (!Array.isArray(raw)) return [];
  const result: Array<{ id: string; run_id: string; round: number; summary: string; options: Array<{ thread_id: string; gist: string }>; status: "open" }> = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const summary = String(entry.summary ?? "").trim();
    if (!summary) continue;
    const rawOptions = Array.isArray(entry.options) ? entry.options : [];
    const options: Array<{ thread_id: string; gist: string }> = [];
    for (const opt of rawOptions) {
      if (!isRecord(opt)) continue;
      const thread_id = String(opt.thread_id ?? "").trim();
      const gist = String(opt.gist ?? "").trim();
      if (!thread_id || !gist) continue;
      options.push({ thread_id, gist });
    }
    if (options.length < 2) continue;
    result.push({
      id: `conf_${crypto.randomUUID().replace(/-/g, "")}`,
      run_id: runId,
      round,
      summary,
      options,
      status: "open",
    });
  }
  return result;
}

export function parseConsolidationResult(text: string, runId = "unknown", round = 0): ConsolidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error("Consolidation did not return valid JSON");
    }
    throw err;
  }
  const normalizedBriefItems = normalizeBriefItems((parsed as Record<string, unknown>).brief_items);
  const briefItems = BriefItemSchema.array().parse(normalizedBriefItems);
  const rawConflicts = (parsed as Record<string, unknown>).conflicts;
  const rawConflictCount = Array.isArray(rawConflicts) ? rawConflicts.length : 0;
  const normalizedConflicts = normalizeConflicts(rawConflicts, runId, round);
  if (normalizedConflicts.length < rawConflictCount) {
    const dropped = rawConflictCount - normalizedConflicts.length;
    console.warn(`consolidation: dropped ${dropped} malformed conflict(s) from LLM output`);
  }
  const conflicts = AnnotationConflictSchema.array().parse(normalizedConflicts);
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

export function askQuestionTool(
  askQuestion: (params: AskQuestionParams) => Promise<AskQuestionOutcome>,
): ToolDefinition {
  return defineTool({
    name: "ask_question",
    label: "Ask the room a question",
    description: [
      "Pose a question to the room and block until a human answers or the question is cancelled.",
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
      "Set answerable_by: 'decider' when only the session initiator should answer; otherwise use 'anyone'.",
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
          [Type.Literal("decider"), Type.Literal("anyone")],
          { description: "Who may answer: 'decider' (session initiator only) or 'anyone' (any participant). Defaults to 'decider'." },
        ),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
