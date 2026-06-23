import type {
  CostInfo,
  ConsolidationAnnotation,
  PreviewApp,
  SandboxToDOMessage,
  QuestionOption,
  AnswerableBy,
  ParticipantIdentity,
} from "@codevil/shared";
import type { CommandRunner, Verifier } from "./verification.js";

export interface AgentStartOptions {
  cwd: string;
  mode: "coding";
  model: string;
  provider: string;
  llmKey?: string;
  onEvent(event: unknown): void;
  createPullRequest(options: CreatePullRequestToolOptions): Promise<{ url: string }>;
  askQuestion?: (params: AskQuestionParams) => Promise<AskQuestionOutcome>;
}

export interface CreatePullRequestToolOptions {
  title: string;
  body: string;
  branch?: string;
  commit_message?: string;
  draft?: boolean;
}

export interface AskQuestionParams {
  question: string;
  context?: string;
  options?: QuestionOption[];
  allow_freeform: boolean;
  allow_multiple: boolean;
  answerable_by: AnswerableBy;
  assigned_to?: ParticipantIdentity;
}

export type AskQuestionOutcome =
  | { cancelled: false; option_ids: string[]; freeform?: string; answered_by: ParticipantIdentity }
  | { cancelled: true; reason: string };

export interface TurnResult {
  response: string;
  cost: CostInfo;
}

export interface PlanResult {
  plan: string;
  cost: CostInfo;
}

export interface ConsolidationInput {
  cwd: string;
  run_id: string;
  round: number;
  model: string;
  provider: string;
  llmKey?: string;
  plan: string;
  annotations: ConsolidationAnnotation[];
  askQuestion?: (params: AskQuestionParams) => Promise<AskQuestionOutcome>;
}

export interface ConsolidationResult {
  /** Prose brief emitted by the ask_question-aware consolidation path. */
  brief: string;
  cost: CostInfo;
}

export interface AgentDriver {
  start(options: AgentStartOptions): Promise<void>;
  turn(prompt: string): Promise<TurnResult>;
  plan(prompt: string): Promise<PlanResult>;
  refine(feedback: string): Promise<PlanResult>;
  consolidateAnnotations?(input: ConsolidationInput): Promise<ConsolidationResult>;
  switchToExecution(model: string, provider?: string): Promise<void>;
  execute(plan: string): Promise<CostInfo>;
  dispose?(): Promise<void> | void;
}

export interface AgentDriverFactory {
  (): AgentDriver;
}

export interface GitDriver {
  clone(repo: string, destination: string, onProgress: (line: string) => void, credential?: GitCredential): Promise<void>;
  defaultBranch(cwd: string): Promise<string>;
  pushBranch(options: PushBranchOptions): Promise<void>;
}

export interface GitCredential {
  username: string;
  password: string;
}

export interface PushBranchOptions {
  cwd: string;
  branch: string;
  commitMessage: string;
  credential?: GitCredential;
}

export type RepoState =
  | { state: "uninit" }
  | {
      state: "ready";
      dir: string;
      url: string;
      defaultBranch: string;
      apps: PreviewApp[];
    };

export interface SandboxRuntimeOptions {
  workspace: string;
  provider?: string;
  llmKey?: string;
  send(message: SandboxToDOMessage): void;
  agentFactory: AgentDriverFactory;
  git: GitDriver;
  verifier?: Verifier;
  commandRunner?: CommandRunner;
  credentialTimeoutMs?: number;
}
