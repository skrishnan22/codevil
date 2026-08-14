import type {
  CLIToDOMessage,
  AnnotationAnchor,
  ParticipantIdentity,
} from "@codevil/shared";
import { MAX_REFINEMENT_ROUNDS, isTerminalState } from "@codevil/shared";
import {
  createAgentRun,
  enqueueAgentRun,
} from "../agent-runs.js";
import { proseBriefFromNote, toConsolidationAnnotations } from "../annotations.js";
import { canAnswerQuestion } from "../question-policy.js";
import type { MembershipRow } from "../memberships.js";
import {
  loadAnnotation,
  loadFullPlanRevision,
  loadOpenAnnotationThreads,
} from "./plan-revisions-store.js";
import {
  listOpenQuestionIds,
  loadQuestionRow,
  questionAnswerDeniedMessage,
} from "./questions-store.js";
import { applyQuestionAnswer } from "./question-answer.js";
import type { OrchestratorHost } from "./host.js";
import { workspaceCacheJobIsRunning } from "./workspace-cache-job.js";
import {
  decisionRejection,
  ensureActiveRun,
  finishRunAndDrainQueue,
  recordDecision,
  setActiveRunState,
  startAgentRun,
} from "./agent-run-coordinator.js";
import {
  ensureAnnotatableRevision,
  lockPlanRevision,
} from "./plan-revision-actions.js";

export function handleApprove(
  host: OrchestratorHost,
  actor: string,
  runId?: string,
  _userId?: string | null,
  _role?: MembershipRow["role"] | null,
): void {
  if (!host.meta) return;

  if (!ensureActiveRun(host, runId)) return;

  if (host.meta.state !== "awaiting_approval") {
    host.appendAndBroadcast(decisionRejection(host, "approve", `Cannot approve in state: ${host.meta.state}`));
    return;
  }

  if (host.transition("executing")) {
    setActiveRunState(host, "executing");
    recordDecision(host, { actor, action: "approve", refinement_round: host.meta.refinement_round });
    host.appendAndBroadcast({
      type: "plan_execution_started",
      run_id: host.meta.active_run?.id ?? "run_unknown",
      actor,
    });
    host.sendToSandbox({
      type: "execute",
      plan: host.meta.latest_plan ?? "",
      model: host.meta.exec_model,
      provider: host.meta.provider,
    });
  }
}

export function handleHumanMessage(
  host: OrchestratorHost,
  text: string,
  actor: ParticipantIdentity,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  host.appendAndBroadcast({
    type: "human_message",
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    actor,
    text: trimmed,
    created_at: new Date().toISOString(),
  });
  host.updateDirectory({});
}

export function handleAgentRequest(
  host: OrchestratorHost,
  text: string,
  actor: ParticipantIdentity,
  planFirst: boolean,
  displayText?: string,
): void {
  if (!host.meta) return;

  const trimmed = text.trim();
  if (!trimmed) return;

  const run = createAgentRun({
    actor,
    text: trimmed,
    now: new Date().toISOString(),
    planFirst,
  });

  host.appendAndBroadcast({
    type: "agent_request",
    run_id: run.id,
    actor,
    text: displayText?.trim() || run.text,
    created_at: run.created_at,
  });

  const next = enqueueAgentRun({
    active: host.meta.active_run ?? null,
    queue: host.meta.queued_runs,
  }, run, {
    sessionReady: host.meta.state === "ready" && !workspaceCacheJobIsRunning(host.sql),
  });

  host.meta.active_run = next.active;
  host.meta.queued_runs = next.queue;
  host.saveMeta();

  if (next.queued) {
    host.appendAndBroadcast({
      type: "agent_request_queued",
      run_id: next.queued.run.id,
      position: next.queued.position,
    });
    host.updateDirectory({});
    return;
  }

  if (next.started) {
    startAgentRun(host, next.started);
  }
}

export function handleAnnotationCreate(
  host: OrchestratorHost,
  runId: string,
  round: number,
  anchor: AnnotationAnchor,
  comment: string,
  actor: ParticipantIdentity,
): void {
  if (!ensureAnnotatableRevision(host, runId, round)) return;

  const now = new Date().toISOString();
  const annotation = {
    id: `ann_${crypto.randomUUID().replace(/-/g, "")}`,
    run_id: runId,
    round,
    anchor,
    author: actor,
    comment: comment.trim(),
    status: "open" as const,
    created_at: now,
  };

  host.sql.exec(
    `INSERT INTO annotations (
      id, revision_run_id, revision_round, anchor_json, author_id,
      author_name, comment, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    annotation.id,
    runId,
    round,
    JSON.stringify(anchor),
    actor.id,
    actor.name,
    annotation.comment,
    annotation.status,
    now,
  );

  host.appendAndBroadcast({ type: "annotation_created", annotation });
}

export function handleAnnotationReply(
  host: OrchestratorHost,
  threadId: string,
  comment: string,
  actor: ParticipantIdentity,
): void {
  const annotation = loadAnnotation(host.sql, threadId);
  if (!annotation) {
    host.appendAndBroadcast({ type: "error", message: "Annotation not found." });
    return;
  }
  if (!ensureAnnotatableRevision(host, annotation.revision_run_id, annotation.revision_round)) return;
  if (annotation.status !== "open") {
    host.appendAndBroadcast({ type: "error", message: "Cannot reply to a closed annotation." });
    return;
  }

  const now = new Date().toISOString();
  const reply = {
    id: `rep_${crypto.randomUUID().replace(/-/g, "")}`,
    author: actor,
    comment: comment.trim(),
    created_at: now,
  };

  host.sql.exec(
    `INSERT INTO annotation_replies (
      id, annotation_id, author_id, author_name, body, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    reply.id,
    threadId,
    actor.id,
    actor.name,
    reply.comment,
    now,
  );

  host.appendAndBroadcast({ type: "annotation_replied", thread_id: threadId, reply });
}

export function handleAnnotationWithdraw(
  host: OrchestratorHost,
  threadId: string,
  actor: ParticipantIdentity,
): void {
  const annotation = loadAnnotation(host.sql, threadId);
  if (!annotation) {
    host.appendAndBroadcast({ type: "error", message: "Annotation not found." });
    return;
  }
  if (!ensureAnnotatableRevision(host, annotation.revision_run_id, annotation.revision_round)) return;
  if (annotation.status !== "open") {
    host.appendAndBroadcast({ type: "error", message: "Cannot withdraw a closed annotation." });
    return;
  }
  if (annotation.author_id !== actor.id) {
    host.appendAndBroadcast({ type: "error", message: "Only the annotation author can withdraw it." });
    return;
  }

  const now = new Date().toISOString();
  host.sql.exec(
    "UPDATE annotations SET status = 'withdrawn' WHERE id = ?",
    threadId,
  );
  host.appendAndBroadcast({
    type: "annotation_withdrawn",
    thread_id: threadId,
    withdrawn_by: actor,
    withdrawn_at: now,
  });
}

// Abort is an always-available kill switch, not a plan decision — it is
// deliberately NOT gated by first-action-wins (so aborting during execution
// is valid, not a "lost race").
export function handleAbort(host: OrchestratorHost, actor: string, runId?: string): void {
  if (!host.meta) return;

  if (!ensureActiveRun(host, runId)) return;

  if (isTerminalState(host.meta.state)) {
    host.appendAndBroadcast({
      type: "error",
      message: `Session already in terminal state: ${host.meta.state}`,
    });
    return;
  }

  const activeRunId = host.meta.active_run?.id;
  if (host.transition("ready")) {
    host.appendAndBroadcast({
      type: "status",
      message: "Agent run cancelled.",
      actor,
    });
    if (activeRunId) {
      cancelOpenQuestions(host, activeRunId, "run cancelled");
      host.appendAndBroadcast({
        type: "agent_run_failed",
        run_id: activeRunId,
        message: "Agent run cancelled.",
      });
    }
    finishRunAndDrainQueue(host, "cancelled");
    // Preview stays alive; user can keep iterating in the iframe until they
    // press "Stop Session" or the container hits idle/max timeout.
  }
}

export function handleRefine(
  host: OrchestratorHost,
  feedback: string,
  actor: string,
  runId?: string,
): void {
  if (!host.meta) return;

  if (!ensureActiveRun(host, runId)) return;

  if (host.meta.state !== "awaiting_approval") {
    host.appendAndBroadcast(decisionRejection(host, "refine", `Cannot refine in state: ${host.meta.state}`));
    return;
  }

  if (host.meta.refinement_round >= MAX_REFINEMENT_ROUNDS) {
    host.appendAndBroadcast({
      type: "error",
      message: `Maximum refinement rounds (${MAX_REFINEMENT_ROUNDS}) reached.`,
    });
    return;
  }

  if (host.transition("refining")) {
    setActiveRunState(host, "thinking");
    // Record the decision against the round being refined (before the
    // increment) so a same-round rejection can be attributed correctly.
    recordDecision(host, { actor, action: "refine", refinement_round: host.meta.refinement_round });
    host.appendAndBroadcast({
      type: "status",
      message: `Refining plan (round ${host.meta.refinement_round + 1}/${MAX_REFINEMENT_ROUNDS}): ${feedback}`,
      actor,
    });

    if (host.meta.active_run?.plan_first) {
      startPlanFirstRefinement(host, feedback);
      return;
    }

    dispatchProseBrief(host, feedback);
  }
}

export function startPlanFirstRefinement(host: OrchestratorHost, feedback: string): void {
  if (!host.meta?.active_run) return;

  const runId = host.meta.active_run.id;
  const round = host.meta.refinement_round;
  const revision = loadFullPlanRevision(host.sql, runId, round);
  if (!revision) {
    host.transition("awaiting_approval");
    setActiveRunState(host, "awaiting_approval");
    host.appendAndBroadcast({ type: "error", message: "Plan revision not found." });
    return;
  }

  lockPlanRevision(host, runId, round);
  const threads = loadOpenAnnotationThreads(host.sql, runId, round);

  if (threads.length <= 1) {
    dispatchProseBrief(host, proseBriefFromNote(feedback, threads));
    return;
  }

  const requestId = `con_${crypto.randomUUID().replace(/-/g, "")}`;
  host.appendAndBroadcast({
    type: "consolidation_started",
    run_id: runId,
    round,
  });
  host.sendToSandbox({
    type: "consolidate_annotations",
    run_id: runId,
    round,
    plan_revision_id: `${runId}:${round}`,
    plan: revision.markdown,
    annotations: toConsolidationAnnotations(threads),
    model: host.meta.plan_model,
    provider: host.meta.provider,
  });
  host.getTracer()?.log("INFO", "consolidation.requested", { request_id: requestId, run_id: runId, round });
}

export function dispatchProseBrief(host: OrchestratorHost, brief: string): void {
  if (!host.meta?.active_run) return;
  const fromRound = host.meta.refinement_round;
  const toRound = fromRound + 1;

  host.meta.refinement_round = toRound;
  host.saveMeta();
  host.appendAndBroadcast({
    type: "brief_dispatched",
    run_id: host.meta.active_run.id,
    from_round: fromRound,
    to_round: toRound,
    brief,
  });
  host.sendToSandbox({
    type: "refine_plan",
    feedback: brief.trim().length > 0 ? brief : "Refine the plan.",
  });
}

export function handleQuestionAssign(
  host: OrchestratorHost,
  msg: Extract<CLIToDOMessage, { type: "question_assign" }>,
  actor: ParticipantIdentity,
  userId: string | null,
  role: MembershipRow["role"] | null,
): void {
  if (!host.meta) return;

  const question = loadQuestionRow(host.sql, msg.request_id);
  if (!question || question.status !== "open") {
    host.appendAndBroadcast({ type: "error", message: "Question not found or already answered." });
    return;
  }

  if (!canAnswerQuestion("decider", userId, host.meta.created_by?.id, role)) {
    host.appendAndBroadcast({ type: "error", message: "Only the session creator can assign this question." });
    return;
  }

  const now = new Date().toISOString();
  host.sql.exec(
    `UPDATE questions
     SET answerable_by = 'assigned', assigned_to_id = ?, assigned_to_name = ?
     WHERE request_id = ?`,
    msg.assigned_to.id,
    msg.assigned_to.name,
    msg.request_id,
  );

  host.appendAndBroadcast({
    type: "question_assigned",
    request_id: msg.request_id,
    assigned_to: msg.assigned_to,
    assigned_by: actor,
    assigned_at: now,
  });
}

export function handleQuestionAnswer(
  host: OrchestratorHost,
  msg: Extract<CLIToDOMessage, { type: "question_answer" }>,
  actor: ParticipantIdentity,
  userId: string | null,
  role: MembershipRow["role"] | null,
): void {
  if (!host.meta) return;

  const question = loadQuestionRow(host.sql, msg.request_id);
  if (!question || question.status !== "open") {
    host.appendAndBroadcast({ type: "error", message: "Question not found or already answered." });
    return;
  }

  if (!canAnswerQuestion(question.answerable_by, userId, host.meta.created_by?.id, role, question.assigned_to_id)) {
    host.appendAndBroadcast({ type: "error", message: questionAnswerDeniedMessage(question) });
    return;
  }

  const result = applyQuestionAnswer(host, {
    requestId: msg.request_id,
    optionIds: msg.option_ids,
    freeform: msg.freeform,
    actor,
  });
  if (!result.ok) host.appendAndBroadcast({ type: "error", message: result.error });
}

export function cancelOpenQuestions(host: OrchestratorHost, runId: string, reason: string): void {
  const openQuestions = listOpenQuestionIds(host.sql, runId).map((request_id) => ({ request_id }));

  if (openQuestions.length === 0) return;

  host.sql.exec(
    `UPDATE questions SET status = 'cancelled', cancelled_reason = ? WHERE run_id = ? AND status = 'open'`,
    reason,
    runId,
  );

  for (const { request_id } of openQuestions) {
    host.sendToSandbox({ type: "ask_question_cancelled", request_id, reason });
  }
}

export async function handlePreviewStart(host: OrchestratorHost, appKey?: string): Promise<void> {
  if (!host.meta) return;

  host.sendToSandbox({
    type: "preview_start",
    model: host.meta.plan_model,
    provider: host.meta.provider,
    task_prompt: host.meta.prompt,
    app_key: appKey,
  });
}

export async function handlePreviewStop(host: OrchestratorHost): Promise<void> {
  host.sendToSandbox({ type: "preview_stop" });
}
