/**
 * Event → chat message mappers for session projection.
 */

import type { DOToCLIEvent } from "./messages-cli.js";
import { isRecord } from "./records.js";
import type { ChatMessage, ProjectionContext } from "./projection-types.js";

export function mapEventToChat(event: DOToCLIEvent, ctx: ProjectionContext): ChatMessage[] {
  const ts = ctx.now;

  switch (event.type) {
    case "session_created":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: `Session created: ${event.session_id}`,
          timestamp: ts,
        },
      ];

    case "status":
      if (event.message === "Waiting for user approval.") return [];
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: event.message,
          timestamp: ts,
          actor: event.actor,
        },
      ];

    case "clone_progress":
      return [];

    case "phase":
      return [];

    case "plan_ready":
      return [
        {
          id: ctx.uid(),
          role: "assistant",
          variant: "plan",
          content: event.plan,
          timestamp: ts,
          meta: { cost: event.cost, refinement_round: event.refinement_round },
        },
      ];

    case "approval_requested":
      return [
        {
          id: ctx.uid(),
          role: "assistant",
          variant: "plan",
          content: event.plan,
          timestamp: ts,
          meta: {
            run_id: event.run_id,
            cost: event.cost,
            refinement_round: event.refinement_round,
          },
        },
      ];

    case "plan_execution_started":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: "Plan approved. Starting execution.",
          timestamp: ts,
          actor: event.actor,
        },
      ];

    case "verification_failed":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "verification_failed",
          content: `Verification failed after ${event.attempts} attempt${event.attempts === 1 ? "" : "s"}.`,
          timestamp: ts,
          meta: { attempts: event.attempts, last_error: event.last_error },
        },
      ];

    case "complete":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "complete",
          content: "Session completed.",
          timestamp: ts,
          meta: { pr_url: event.pr_url },
        },
      ];

    case "error":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "error",
          content: event.message,
          timestamp: ts,
          actor: event.actor,
        },
      ];

    case "preview_starting":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: `Starting preview: ${event.command}`,
          timestamp: ts,
        },
      ];

    case "preview_ready":
      return [];

    case "preview_error":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "error",
          content: event.message,
          timestamp: ts,
        },
      ];

    case "preview_stopped":
      return [];

    case "preview_apps":
      return [];

    case "room_ready":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: `Room ready for ${event.repo}`,
          timestamp: ts,
        },
      ];

    case "participant_joined":
    case "participant_left":
      return [];

    case "human_message":
      return [
        {
          id: event.id,
          role: "user",
          variant: "text",
          content: event.text,
          timestamp: Date.parse(event.created_at) || ts,
          actor: event.actor.name,
          meta: { actor_id: event.actor.id },
        },
      ];

    case "agent_request":
      return [
        {
          id: event.run_id,
          role: "user",
          variant: "text",
          content: `@codevil ${event.text}`,
          timestamp: Date.parse(event.created_at) || ts,
          actor: event.actor.name,
          meta: { actor_id: event.actor.id, run_id: event.run_id },
        },
      ];

    case "agent_request_queued":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: `Queued agent request #${event.position}.`,
          timestamp: ts,
          meta: { run_id: event.run_id },
        },
      ];

    case "agent_run_started":
      return [];

    case "agent_response":
      return [
        {
          id: ctx.uid(),
          role: "assistant",
          variant: "text",
          content: event.text,
          timestamp: ts,
          meta: { run_id: event.run_id },
        },
      ];

    case "agent_run_completed":
      return [];

    case "agent_run_failed":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "error",
          content: event.message,
          timestamp: ts,
          meta: { run_id: event.run_id },
        },
      ];

    case "agent_event":
      return mapAgentEventToChat(event.event, ctx);

    case "plan_revision_frozen":
      return [];

    case "annotation_created":
      return [
        {
          id: event.annotation.id,
          role: "system",
          variant: "status",
          content: `${event.annotation.author.name} annotated the plan: ${event.annotation.comment}`,
          timestamp: Date.parse(event.annotation.created_at) || ts,
          actor: event.annotation.author.name,
          meta: { run_id: event.annotation.run_id, refinement_round: event.annotation.round },
        },
      ];

    case "annotation_replied":
      return [
        {
          id: event.reply.id,
          role: "system",
          variant: "status",
          content: `${event.reply.author.name} replied to an annotation: ${event.reply.comment}`,
          timestamp: Date.parse(event.reply.created_at) || ts,
          actor: event.reply.author.name,
        },
      ];

    case "annotation_withdrawn":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: `${event.withdrawn_by.name} withdrew an annotation.`,
          timestamp: Date.parse(event.withdrawn_at) || ts,
          actor: event.withdrawn_by.name,
        },
      ];

    case "consolidation_started":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: "Consolidating plan feedback.",
          timestamp: ts,
          meta: { run_id: event.run_id, refinement_round: event.round },
        },
      ];

    case "brief_dispatched":
      return [
        {
          id: ctx.uid(),
          role: "system",
          variant: "status",
          content: "Refinement brief dispatched.",
          timestamp: ts,
          meta: { run_id: event.run_id, refinement_round: event.to_round },
        },
      ];

    case "annotations_consumed":
      return [];

    case "question_raised":
    case "question_assigned":
    case "question_answered":
      return [];
  }
}

function mapAgentEventToChat(raw: unknown, ctx: ProjectionContext): ChatMessage[] {
  if (!isRecord(raw) || typeof raw.type !== "string") return [];

  switch (raw.type) {
    case "tool_execution_end":
    case "message_update":
      return [];
    default:
      return [];
  }
}

export function appendProjectedChatMessages(
  messages: ChatMessage[],
  event: DOToCLIEvent,
  ctx: ProjectionContext,
): ChatMessage[] {
  const mapped = mapEventToChat(event, ctx);
  if (mapped.length === 0) return messages;
  return [...messages, ...mapped];
}
