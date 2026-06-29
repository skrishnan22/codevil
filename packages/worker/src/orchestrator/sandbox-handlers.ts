import type {
  CostInfo,
  DOToSandboxMessage,
  SandboxToDOMessage,
} from "@codevil/shared";
import { SandboxToDOMessageSchema, parseInbound } from "@codevil/shared";
import {
  buildSandboxWebSocketUrl,
  provisionSandbox,
} from "../sandbox.js";
import {
  createWorkspaceCacheSnapshotForSandbox,
  restoreLatestWorkspaceCache,
  type WorkspaceCacheSandbox,
} from "../workspace-cache.js";
import type { SandboxConnectionMode } from "../sandbox-connection.js";
import { createDraftPullRequest, credentialRequestAllowed } from "../github.js";
import { getProvisioningCredentialContext } from "../provider-credentials.js";
import { traceSandboxProvisioning } from "./provisioning.js";
import {
  buildPreviewUrl,
  createPreviewToken,
  hashPreviewToken,
} from "./preview.js";
import { slugify } from "./session-guards.js";
import type { OrchestratorHost } from "./host.js";
import {
  completeActiveRun,
  failActiveRunAndReturnReady,
  finishRunAndDrainQueue,
  setActiveRunState,
} from "./agent-run-coordinator.js";
import { freezePlanRevision } from "./plan-revision-actions.js";
import {
  cancelOpenQuestions,
  dispatchProseBrief,
} from "./cli-handlers.js";

export async function provisionSessionSandbox(host: OrchestratorHost): Promise<void> {
  host.loadMeta();
  if (!host.meta) return;

  if (!host.transition("provisioning_sandbox")) return;
  host.updateDirectory({ sandbox_state: "provisioning" });

  const tracer = host.getTracer();
  try {
    const wsUrl = buildSandboxWebSocketUrl(host.meta.worker_url, host.meta.session_id);
    const provisioningContext = getProvisioningCredentialContext(host.workerEnv, host.meta.provider);
    await traceSandboxProvisioning({
      tracer: tracer!,
      secrets: host.redactionSecrets,
      attributes: {
        provider: host.meta.provider,
        plan_model: host.meta.plan_model,
        has_llm_key: provisioningContext.hasLlmKey,
      },
      provision: () =>
        provisionSandbox({
          binding: host.workerEnv.Sandbox,
          sessionId: host.meta!.session_id,
          wsUrl,
          apiKey: host.workerEnv.CODEVIL_API_KEY,
          provider: host.meta!.provider,
          llmKey: provisioningContext.llmKey,
          beforeStart: async (sandbox) => {
            const restored = await restoreWorkspaceCacheBeforeStart(host, sandbox as WorkspaceCacheSandbox);
            if (host.meta) {
              host.meta.workspace_cache_restored = restored;
              host.saveMeta();
            }
          },
        }),
    });
    host.appendAndBroadcast({ type: "status", message: "Sandbox process started." });
  } catch (error) {
    host.transition("failed");
    host.appendAndBroadcast({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function initializeSandboxConnection(
  host: OrchestratorHost,
  ws: WebSocket,
  mode: SandboxConnectionMode,
): void {
  host.loadMeta();
  if (!host.meta) {
    host.getTracer()?.log("ERROR", "sandbox.init.no_meta", {});
    return;
  }

  const tracer = host.getTracer();
  tracer?.log("INFO", "start_sandbox_init", {
    state: host.meta.state,
    provider: host.meta.provider,
    plan_model: host.meta.plan_model,
  });

  if (mode === "resume") {
    tracer?.log("INFO", "sandbox.ws.resumed", { state: host.meta.state });
    return;
  }

  ws.send(JSON.stringify({
    type: "init",
    repo: host.meta.repo,
    ...(host.meta.workspace_cache_restored ? { restored_from_cache: true } : {}),
    ...(tracer ? { trace_id: tracer.trace_id } : {}),
  } satisfies DOToSandboxMessage));
}

export async function dispatchSandboxSocketMessage(
  host: OrchestratorHost,
  ws: WebSocket,
  message: string,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
    return;
  }
  const parsed = parseInbound(SandboxToDOMessageSchema, raw, "sandbox_to_do");
  if (!parsed) return;

  host.loadMeta();
  if (!host.meta) return;

  switch (parsed.type) {
    case "clone_started":
      handleSandboxCloneStarted(host);
      return;
    case "clone_complete":
      handleSandboxCloneComplete(host);
      return;
    case "plan_ready":
      handleSandboxPlanReady(host, parsed.plan, parsed.cost);
      return;
    case "agent_turn_complete":
      handleSandboxAgentTurnComplete(host, parsed.run_id, parsed.response, parsed.cost);
      return;
    case "create_pr_request":
      await handleCreatePullRequestRequest(host, ws, parsed);
      return;
    case "verification_started":
      handleSandboxVerificationStarted(host, parsed.attempt, parsed.max_attempts);
      return;
    case "verification_retrying":
      handleSandboxVerificationRetrying(host, parsed.attempt, parsed.max_attempts, parsed.last_error);
      return;
    case "execution_complete":
      handleSandboxExecutionComplete(host, parsed.cost);
      return;
    case "consolidation_complete":
      handleConsolidationComplete(host, parsed.run_id, parsed.round, parsed.brief, parsed.cost);
      return;
    case "consolidation_failed":
      handleConsolidationFailed(host, parsed.run_id, parsed.round, parsed.message);
      return;
    case "verification_failed":
      handleSandboxVerificationFailed(host, parsed.attempts, parsed.last_error);
      return;
    case "ask_question_request":
      handleAskQuestionRequest(host, parsed);
      return;
    case "credential_request":
      handleCredentialRequest(host, ws, parsed);
      return;
    case "branch_pushed":
      await handleBranchPushed(host, parsed.branch, parsed.base_branch, parsed.pr_title, parsed.pr_body);
      return;
    case "pr_created":
      completeActiveRun(host, parsed.url);
      return;
    case "preview_starting":
      host.appendAndBroadcast({ type: "preview_starting", command: parsed.command, port: parsed.port });
      return;
    case "preview_ready":
      await handleSandboxPreviewReady(host, parsed.command, parsed.port);
      return;
    case "preview_error":
      host.revokePreview();
      host.appendAndBroadcast({ type: "preview_error", message: parsed.message });
      return;
    case "preview_stopped":
      host.revokePreview();
      host.appendAndBroadcast({ type: "preview_stopped" });
      return;
    case "preview_apps":
      host.appendAndBroadcast({ type: "preview_apps", apps: parsed.apps });
      return;
    case "error":
      if (host.meta.active_run && host.meta.state === "executing") {
        cancelOpenQuestions(host, host.meta.active_run.id, "run failed");
        failActiveRunAndReturnReady(host, parsed.message);
      } else {
        const activeRunId = host.meta.active_run?.id;
        host.transition("failed");
        if (activeRunId) {
          cancelOpenQuestions(host, activeRunId, "session failed");
        }
        host.appendAndBroadcast({ type: "error", message: parsed.message });
      }
      return;
    case "status":
      host.appendAndBroadcast({ type: "status", message: parsed.message });
      return;
    case "clone_progress":
      host.appendAndBroadcast({ type: "clone_progress", line: parsed.line });
      return;
    case "agent_event":
      host.appendAndBroadcast({ type: "agent_event", event: parsed.event });
      return;
    default: {
      const _exhaustive: never = parsed;
      return _exhaustive;
    }
  }
}

export function handleSandboxCloneStarted(host: OrchestratorHost): void {
  if (!host.meta) return;
  if (host.meta.state !== "provisioning_sandbox") return;
  if (host.transition("cloning_repo")) {
    host.updateDirectory({ sandbox_state: "cloning" });
  }
}

export function handleSandboxCloneComplete(host: OrchestratorHost): void {
  if (!host.meta) return;
  if (host.meta.state !== "cloning_repo") return;

  if (host.transition("ready")) {
    host.updateDirectory({ room_state: "ready", sandbox_state: "ready" });
    host.appendAndBroadcast({ type: "status", message: "Repository cloned. Room is ready." });
    host.appendAndBroadcast({ type: "room_ready", repo: host.meta.repo });
    scheduleWorkspaceCacheSnapshot(host);
    if (!host.meta.active_run && host.meta.queued_runs.length > 0) {
      finishRunAndDrainQueue(host, "completed");
    }
  }
}

async function restoreWorkspaceCacheBeforeStart(
  host: OrchestratorHost,
  sandbox: WorkspaceCacheSandbox,
): Promise<boolean> {
  if (!host.meta) return false;
  const result = await restoreLatestWorkspaceCache({
    db: host.workerEnv.DB,
    sandbox,
    repo: host.meta.repo,
  });

  if (result.restored) {
    host.getTracer()?.log("INFO", "workspace_cache.restore.hit", {
      snapshot_id: result.snapshotId,
      repo: host.meta.repo,
    });
    host.appendAndBroadcast({ type: "status", message: "Restored cached workspace. Updating repository." });
    return true;
  }

  host.getTracer()?.log("INFO", "workspace_cache.restore.miss", {
    snapshot_id: result.snapshotId,
    reason: result.reason,
    repo: host.meta.repo,
  });
  return false;
}

function scheduleWorkspaceCacheSnapshot(host: OrchestratorHost): void {
  if (!host.meta) return;
  const sessionId = host.meta.session_id;
  const repo = host.meta.repo;
  host.ctx.waitUntil((async () => {
    const result = await createWorkspaceCacheSnapshotForSandbox({
      db: host.workerEnv.DB,
      binding: host.workerEnv.Sandbox,
      sessionId,
      repo,
    });
    if (result.created) {
      host.getTracer()?.log("INFO", "workspace_cache.create.ready", {
        snapshot_id: result.snapshotId,
        repo,
      });
      return;
    }
    host.getTracer()?.log("WARN", "workspace_cache.create.skipped", {
      reason: result.reason,
      repo,
    });
  })());
}

export function handleSandboxPlanReady(host: OrchestratorHost, plan: string, cost: CostInfo): void {
  if (!host.meta) return;

  host.meta.latest_plan = plan;
  host.saveMeta();

  host.trackCost(cost);

  if (host.meta.state !== "planning" && host.meta.state !== "refining") return;

  if (host.meta.active_run?.plan_first) {
    freezePlanRevision(host, host.meta.active_run.id, host.meta.refinement_round, plan);
  }
  if (host.transition("awaiting_approval")) {
    setActiveRunState(host, "awaiting_approval");
    host.appendAndBroadcast({
      type: "approval_requested",
      run_id: host.meta.active_run?.id ?? "run_unknown",
      plan,
      cost,
      refinement_round: host.meta.refinement_round,
    });
    host.appendAndBroadcast({ type: "status", message: "Waiting for user approval." });
  }
}

export function handleConsolidationComplete(
  host: OrchestratorHost,
  runId: string,
  round: number,
  brief: string,
  cost: CostInfo,
): void {
  if (!host.meta?.active_run || host.meta.state !== "refining") return;
  if (host.meta.active_run.id !== runId || host.meta.refinement_round !== round) return;
  host.trackCost(cost);

  // The consolidation agent resolved any contradictions inline via ask_question
  // and returned a plain-prose brief.
  dispatchProseBrief(host, brief);
}

export function handleConsolidationFailed(
  host: OrchestratorHost,
  runId: string,
  round: number,
  message: string,
): void {
  if (!host.meta?.active_run || host.meta.state !== "refining") return;
  if (host.meta.active_run.id !== runId || host.meta.refinement_round !== round) return;

  if (host.transition("awaiting_approval")) {
    setActiveRunState(host, "awaiting_approval");
    host.appendAndBroadcast({ type: "error", message });
  }
}

export function handleSandboxAgentTurnComplete(
  host: OrchestratorHost,
  runId: string,
  response: string,
  cost: CostInfo,
): void {
  if (!host.meta?.active_run || host.meta.state !== "executing") return;
  if (host.meta.active_run.id !== runId) return;
  host.trackCost(cost);

  host.appendAndBroadcast({
    type: "agent_response",
    run_id: host.meta.active_run.id,
    text: response,
    cost,
  });
  completeActiveRun(host);
}

export function handleSandboxVerificationStarted(
  host: OrchestratorHost,
  attempt: number,
  maxAttempts: number,
): void {
  if (!host.meta) return;
  if (host.meta.state === "executing" || host.meta.state === "retrying") {
    host.meta.verification_attempts = attempt;
    host.saveMeta();
    if (host.transition("verifying")) {
      setActiveRunState(host, "verifying");
      host.appendAndBroadcast({
        type: "status",
        message: `Verification started (attempt ${attempt}/${maxAttempts}).`,
      });
    }
    return;
  }

  if (host.meta.state === "verifying") {
    host.meta.verification_attempts = attempt;
    host.saveMeta();
  }
}

export function handleSandboxVerificationRetrying(
  host: OrchestratorHost,
  attempt: number,
  maxAttempts: number,
  _lastError: string,
): void {
  if (!host.meta) return;
  if (host.meta.state !== "verifying") return;

  host.meta.verification_attempts = attempt;
  host.saveMeta();
  if (host.transition("retrying")) {
    setActiveRunState(host, "executing");
    host.appendAndBroadcast({
      type: "status",
      message: `Verification failed on attempt ${attempt}/${maxAttempts}. Asking agent to fix it.`,
    });
  }
}

export function handleSandboxExecutionComplete(host: OrchestratorHost, cost: CostInfo): void {
  if (!host.meta) return;
  host.trackCost(cost);
  if (host.meta.state !== "verifying") return;

  if (host.transition("creating_pr")) {
    setActiveRunState(host, "publishing");
    host.appendAndBroadcast({ type: "status", message: "Execution completed. Creating pull request." });
    const runPrompt = host.meta.active_run?.text ?? host.meta.prompt;
    host.sendToSandbox({
      type: "create_pr",
      branch: `codevil/${slugify(runPrompt)}-${Date.now()}`,
      commit_message: `Implement ${runPrompt}`,
      pr_title: runPrompt,
      pr_body: host.meta.latest_plan ?? runPrompt,
    });
  }
}

export function handleAskQuestionRequest(
  host: OrchestratorHost,
  msg: Extract<SandboxToDOMessage, { type: "ask_question_request" }>,
): void {
  if (!host.meta) return;
  const now = new Date().toISOString();
  const round = host.meta.refinement_round ?? null;

  host.sql.exec(
    `INSERT OR REPLACE INTO questions (
      request_id, run_id, round, question, context, options_json,
      answerable_by, allow_freeform, allow_multiple, status,
      answer_json, answered_by_id, answered_by_name, answered_at,
      assigned_to_id, assigned_to_name, cancelled_reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, NULL, ?, ?, NULL, ?)`,
    msg.request_id,
    msg.run_id,
    round,
    msg.question,
    msg.context ?? null,
    msg.options ? JSON.stringify(msg.options) : null,
    msg.answerable_by,
    msg.allow_freeform ? 1 : 0,
    msg.allow_multiple ? 1 : 0,
    msg.assigned_to?.id ?? null,
    msg.assigned_to?.name ?? null,
    now,
  );

  host.appendAndBroadcast({
    type: "question_raised",
    request_id: msg.request_id,
    run_id: msg.run_id,
    question: msg.question,
    ...(msg.context !== undefined ? { context: msg.context } : {}),
    ...(msg.options !== undefined ? { options: msg.options } : {}),
    allow_freeform: msg.allow_freeform,
    allow_multiple: msg.allow_multiple,
    answerable_by: msg.answerable_by,
    ...(msg.assigned_to !== undefined ? { assigned_to: msg.assigned_to } : {}),
    status: "open",
    raised_at: now,
  });
}

export function handleCredentialRequest(
  host: OrchestratorHost,
  ws: WebSocket,
  request: Extract<SandboxToDOMessage, { type: "credential_request" }>,
): void {
  if (!host.meta) return;

  if (!host.workerEnv.GITHUB_PAT) {
    ws.send(JSON.stringify({
      type: "credential_response",
      request_id: request.request_id,
      error: "GitHub credentials are not configured.",
    } satisfies DOToSandboxMessage));
    return;
  }

  if (!credentialRequestAllowed(host.meta.repo, request)) {
    ws.send(JSON.stringify({
      type: "credential_response",
      request_id: request.request_id,
      error: "Credential request does not match this session repository.",
    } satisfies DOToSandboxMessage));
    return;
  }

  ws.send(JSON.stringify({
    type: "credential_response",
    request_id: request.request_id,
    username: "x-access-token",
    password: host.workerEnv.GITHUB_PAT,
  } satisfies DOToSandboxMessage));
}

export async function handleCreatePullRequestRequest(
  host: OrchestratorHost,
  ws: WebSocket,
  request: Extract<SandboxToDOMessage, { type: "create_pr_request" }>,
): Promise<void> {
  if (!host.meta) return;

  try {
    if (host.meta.state !== "executing" || host.meta.active_run?.id !== request.run_id) {
      throw new Error(`Agent run ${request.run_id} is no longer active.`);
    }
    if (!host.workerEnv.GITHUB_PAT) throw new Error("GitHub credentials are not configured.");
    const url = await createDraftPullRequest({
      repo: host.meta.repo,
      token: host.workerEnv.GITHUB_PAT,
      branch: request.branch,
      baseBranch: request.base_branch,
      title: request.title,
      body: request.body,
      draft: request.draft,
    });
    ws.send(JSON.stringify({
      type: "create_pr_response",
      request_id: request.request_id,
      url,
    } satisfies DOToSandboxMessage));
  } catch (error) {
    ws.send(JSON.stringify({
      type: "create_pr_response",
      request_id: request.request_id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies DOToSandboxMessage));
  }
}

export async function handleBranchPushed(
  host: OrchestratorHost,
  branch: string,
  baseBranch: string,
  prTitle: string,
  prBody: string,
): Promise<void> {
  if (!host.meta) return;
  if (host.meta.state !== "creating_pr") return;

  try {
    if (!host.workerEnv.GITHUB_PAT) throw new Error("GitHub credentials are not configured.");
    const prUrl = await createDraftPullRequest({
      repo: host.meta.repo,
      token: host.workerEnv.GITHUB_PAT,
      branch,
      baseBranch,
      title: prTitle,
      body: prBody,
    });

    completeActiveRun(host, prUrl);
  } catch (error) {
    failActiveRunAndReturnReady(host, error instanceof Error ? error.message : String(error));
  }
}

export function handleSandboxVerificationFailed(
  host: OrchestratorHost,
  attempts: number,
  lastError: string,
): void {
  if (!host.meta) return;
  if (host.meta.state === "verifying") {
    host.appendAndBroadcast({
      type: "verification_failed",
      attempts,
      last_error: lastError,
    });
    failActiveRunAndReturnReady(host, lastError);
  }
}

export async function handleSandboxPreviewReady(
  host: OrchestratorHost,
  command: string,
  port: number,
): Promise<void> {
  if (!host.meta) return;
  const token = createPreviewToken(host.meta.session_id);
  host.meta.preview_token_hash = await hashPreviewToken(token);
  host.meta.preview_url = buildPreviewUrl({
    workerOrigin: host.meta.worker_url,
    previewOrigin: host.workerEnv.CODEVIL_PREVIEW_ORIGIN,
    sessionId: host.meta.session_id,
    token,
  });
  host.meta.preview_port = port;
  host.meta.preview_active = true;
  host.saveMeta();
  host.appendAndBroadcast({
    type: "preview_ready",
    url: host.meta.preview_url,
    command,
    port,
  });
}
