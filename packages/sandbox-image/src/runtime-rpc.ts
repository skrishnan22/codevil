import type { DOToSandboxMessage, SandboxToDOMessage } from "@codevil/shared";
import type { AskQuestionOutcome, AskQuestionParams, CreatePullRequestToolOptions } from "./runtime-types.js";

type CreatePRRequestMessage = Extract<SandboxToDOMessage, { type: "create_pr_request" }>;
type AskQuestionRequestMessage = Extract<SandboxToDOMessage, { type: "ask_question_request" }>;

const DEFAULT_ASK_QUESTION_TIMEOUT_MS = 600_000;

export class SandboxRpcCoordinator {
  private readonly send: (message: SandboxToDOMessage) => void;
  private readonly askQuestionTimeoutMs: number;
  private pullRequestRequests = new Map<string, {
    resolve(result: { url: string }): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private askQuestionRequests = new Map<string, {
    resolve(outcome: AskQuestionOutcome): void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  constructor(options: {
    send: (message: SandboxToDOMessage) => void;
    askQuestionTimeoutMs?: number;
  }) {
    this.send = options.send;
    this.askQuestionTimeoutMs = options.askQuestionTimeoutMs ?? DEFAULT_ASK_QUESTION_TIMEOUT_MS;
  }

  async createPullRequest(options: {
    runId: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
    draft: boolean;
    push: () => Promise<void>;
  }): Promise<{ url: string }> {
    await options.push();

    const requestId = `pr_${crypto.randomUUID().replace(/-/g, "")}`;
    this.send({
      type: "create_pr_request",
      run_id: options.runId,
      request_id: requestId,
      branch: options.branch,
      base_branch: options.baseBranch,
      title: options.title,
      body: options.body,
      draft: options.draft,
    } satisfies CreatePRRequestMessage);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pullRequestRequests.delete(requestId);
        reject(new Error("Timed out waiting for pull request creation"));
      }, 60_000);
      this.pullRequestRequests.set(requestId, { resolve, reject, timeout });
    });
  }

  handleCreatePRResponse(message: Extract<DOToSandboxMessage, { type: "create_pr_response" }>): void {
    const pending = this.pullRequestRequests.get(message.request_id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pullRequestRequests.delete(message.request_id);
    if (message.error || !message.url) {
      pending.reject(new Error(message.error ?? "Pull request creation did not return a URL"));
      return;
    }
    pending.resolve({ url: message.url });
  }

  askQuestion(runId: string, params: AskQuestionParams): Promise<AskQuestionOutcome> {
    const requestId = `q_${crypto.randomUUID().replace(/-/g, "")}`;
    this.send({
      type: "ask_question_request",
      request_id: requestId,
      run_id: runId,
      question: params.question,
      context: params.context,
      options: params.options,
      allow_freeform: params.allow_freeform,
      allow_multiple: params.allow_multiple,
      answerable_by: params.answerable_by,
      assigned_to: params.assigned_to,
    } satisfies AskQuestionRequestMessage);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.askQuestionRequests.delete(requestId);
        resolve({
          cancelled: true,
          reason: "Timed out waiting for question response",
        });
      }, this.askQuestionTimeoutMs);

      this.askQuestionRequests.set(requestId, { resolve, timeout });
    });
  }

  makeAskQuestion(runId: string): (params: AskQuestionParams) => Promise<AskQuestionOutcome> {
    return (params) => this.askQuestion(runId, params);
  }

  handleAskQuestionResponse(message: Extract<DOToSandboxMessage, { type: "ask_question_response" }>): void {
    const pending = this.askQuestionRequests.get(message.request_id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.askQuestionRequests.delete(message.request_id);
    pending.resolve({
      cancelled: false,
      option_ids: message.option_ids,
      freeform: message.freeform,
      answered_by: message.answered_by,
    });
  }

  handleAskQuestionCancelled(message: Extract<DOToSandboxMessage, { type: "ask_question_cancelled" }>): void {
    const pending = this.askQuestionRequests.get(message.request_id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.askQuestionRequests.delete(message.request_id);
    pending.resolve({ cancelled: true, reason: message.reason });
  }
}

export type { CreatePullRequestToolOptions };
