import { z } from "zod";

// Pi (the embedded coding-agent SDK) emits AgentEvents whose exact shape can
// drift between SDK versions. We validate at the sandbox boundary so that
// shape drift surfaces as a `validation_drop` log instead of a silent UI gap.
//
// Strategy: enumerate the discriminators (`type`) Codevil currently depends on
// with a strict literal; allow extra fields via `.passthrough()` so we don't
// reject events when Pi adds adjacent fields. Unknown event types fall through
// to PiUnknownEventSchema so a Pi version that emits a new event type doesn't
// kill the session — it just forwards opaquely.

export const PiToolExecutionStartSchema = z
  .object({
    type: z.literal("tool_execution_start"),
    tool: z.string().optional(),
    toolName: z.string().optional(),
    toolCallId: z.string().optional(),
    args: z.unknown().optional(),
  })
  .passthrough();

export const PiToolExecutionUpdateSchema = z
  .object({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string().optional(),
  })
  .passthrough();

export const PiToolExecutionEndSchema = z
  .object({
    type: z.literal("tool_execution_end"),
    tool: z.string().optional(),
    toolName: z.string().optional(),
    toolCallId: z.string().optional(),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    success: z.boolean().optional(),
    isError: z.boolean().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const PiMessageStartSchema = z
  .object({ type: z.literal("message_start") })
  .passthrough();

export const PiMessageUpdateSchema = z
  .object({
    type: z.literal("message_update"),
    content: z.string().optional(),
    assistantMessageEvent: z
      .object({ delta: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const PiMessageEndSchema = z
  .object({ type: z.literal("message_end") })
  .passthrough();

export const PiTurnStartSchema = z
  .object({ type: z.literal("turn_start") })
  .passthrough();

export const PiTurnEndSchema = z
  .object({
    type: z.literal("turn_end"),
    toolResults: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const PiAgentStartSchema = z
  .object({ type: z.literal("agent_start") })
  .passthrough();

export const PiAgentEndSchema = z
  .object({ type: z.literal("agent_end") })
  .passthrough();

// Catch-all: any object with a string `type` we don't yet model. Lets new Pi
// versions forward through without a deploy. The wire downstream still gets
// the full object; only the type narrowing differs.
export const PiUnknownEventSchema = z
  .object({ type: z.string() })
  .passthrough();

export const PiAgentEventSchema = z.union([
  PiToolExecutionStartSchema,
  PiToolExecutionUpdateSchema,
  PiToolExecutionEndSchema,
  PiMessageStartSchema,
  PiMessageUpdateSchema,
  PiMessageEndSchema,
  PiTurnStartSchema,
  PiTurnEndSchema,
  PiAgentStartSchema,
  PiAgentEndSchema,
  PiUnknownEventSchema,
]);

export type PiToolExecutionStart = z.infer<typeof PiToolExecutionStartSchema>;
export type PiToolExecutionUpdate = z.infer<typeof PiToolExecutionUpdateSchema>;
export type PiToolExecutionEnd = z.infer<typeof PiToolExecutionEndSchema>;
export type PiMessageStart = z.infer<typeof PiMessageStartSchema>;
export type PiMessageUpdate = z.infer<typeof PiMessageUpdateSchema>;
export type PiMessageEnd = z.infer<typeof PiMessageEndSchema>;
export type PiTurnStart = z.infer<typeof PiTurnStartSchema>;
export type PiTurnEnd = z.infer<typeof PiTurnEndSchema>;
export type PiAgentStart = z.infer<typeof PiAgentStartSchema>;
export type PiAgentEnd = z.infer<typeof PiAgentEndSchema>;
export type PiUnknownEvent = z.infer<typeof PiUnknownEventSchema>;
export type PiAgentEvent = z.infer<typeof PiAgentEventSchema>;
