import type { SessionState } from "@codevil/shared";
import type { ActivityEntry, ChatMessage } from "@/types";

export type CurrentAgentKind = "idle" | "running" | "attention" | "summary" | "complete";

export interface CurrentAgentState {
  kind: CurrentAgentKind;
  title: string;
  description?: string;
  badge?: string;
  activityId?: string;
}

export function deriveCurrentAgent({
  messages,
  activityLog,
  sessionPhase,
  planApproved,
}: {
  messages: ChatMessage[];
  activityLog: ActivityEntry[];
  sessionPhase: SessionState | null;
  planApproved: boolean;
}): CurrentAgentState {
  const attention = latestAttention(messages, sessionPhase, planApproved);
  if (attention) return attention;

  const runningTool = [...activityLog]
    .reverse()
    .find((entry) => entry.kind === "tool_call" && entry.status === "running" && entry.tool);
  if (runningTool?.tool) {
    return {
      kind: "running",
      title: runningTool.tool.summary || runningTool.tool.name,
      description: runningTool.tool.args,
      badge: runningTool.tool.name,
      activityId: runningTool.id,
    };
  }

  const runningThinking = [...activityLog]
    .reverse()
    .find((entry) => entry.kind === "thinking" && entry.status === "running" && entry.thinking?.text.trim());
  if (runningThinking?.thinking) {
    return {
      kind: "running",
      title: "Agent is thinking",
      description: runningThinking.thinking.text.trim(),
      badge: "stream",
      activityId: runningThinking.id,
    };
  }

  const latestReply = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.variant === "text" && message.content.trim());
  if (latestReply) {
    return {
      kind: "summary",
      title: "Latest assistant reply",
      description: latestReply.content,
    };
  }

  if (sessionPhase === "completed") {
    return { kind: "complete", title: "Session complete" };
  }

  return { kind: "idle", title: "Waiting for agent activity" };
}

function latestAttention(
  messages: ChatMessage[],
  _sessionPhase: SessionState | null,
  _planApproved: boolean,
): CurrentAgentState | null {
  const latest = [...messages].reverse().find((message) =>
    message.variant === "verification_failed" ||
    message.variant === "error" ||
    message.variant === "plan" ||
    message.variant === "complete"
  );

  if (!latest) return null;

  if (latest.variant === "verification_failed") {
    return {
      kind: "attention",
      title: "Verification failed",
      description: latest.meta?.last_error ? `${latest.content}\n${latest.meta.last_error}` : latest.content,
    };
  }

  if (latest.variant === "error") {
    return {
      kind: "attention",
      title: "Session error",
      description: latest.content,
    };
  }

  if (latest.variant === "complete") {
    return {
      kind: "complete",
      title: "Session complete",
      description: latest.meta?.pr_url ?? latest.content,
    };
  }

  return null;
}
