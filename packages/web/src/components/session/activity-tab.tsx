import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityEntry } from "@/types";
import { useSessionStore } from "@/stores/session-store";
import {
  getActivityFollowStateAfterJump,
  getActivityFollowStateAfterScroll,
} from "./activity-scroll";

interface ActivityTabProps {
  selectedActivityId: string | null;
  onSelectActivity: (id: string | null) => void;
}

type ActivityTurn = {
  id: string;
  index: number;
  title: string;
  entries: ActivityEntry[];
  thinking: ActivityEntry | null;
  tools: ActivityEntry[];
  status: ActivityEntry["status"];
  tokensLabel: string;
  durationLabel: string;
};

type ActivityView = {
  lifecycle: ActivityEntry[];
  turns: ActivityTurn[];
  selectable: ActivityEntry[];
};

export function ActivityTab({ selectedActivityId, onSelectActivity }: ActivityTabProps) {
  const { activityLog } = useSessionStore();
  const view = useMemo(() => deriveActivityView(activityLog), [activityLog]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isFollowingLatestRef = useRef(true);
  const previousContentKeyRef = useRef("");
  const [isNearBottom, setIsNearBottom] = useState(true);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const contentKey = useMemo(() => {
    return activityLog
      .map((entry) => [
        entry.id,
        entry.status,
        entry.tool?.result?.length ?? 0,
        entry.tool?.error?.length ?? 0,
        entry.thinking?.text?.length ?? 0,
        entry.event?.detail?.length ?? 0,
      ].join(":"))
      .join("|");
  }, [activityLog]);

  useEffect(() => {
    if (view.selectable.length === 0) return;
    if (selectedActivityId && view.selectable.some((entry) => entry.id === selectedActivityId)) return;
    onSelectActivity(view.selectable.at(-1)!.id);
  }, [onSelectActivity, selectedActivityId, view.selectable]);

  useEffect(() => {
    if (isFollowingLatestRef.current && contentKey !== previousContentKeyRef.current) {
      requestAnimationFrame(scrollToBottom);
    }
    previousContentKeyRef.current = contentKey;
  }, [contentKey, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = getActivityFollowStateAfterScroll({ distanceFromBottom });
    isFollowingLatestRef.current = next.isFollowingLatest;
    setIsNearBottom(next.isNearBottom);
  }, []);

  function handleJumpToLatest() {
    const next = getActivityFollowStateAfterJump();
    isFollowingLatestRef.current = next.isFollowingLatest;
    setIsNearBottom(next.isNearBottom);
    scrollToBottom();
  }

  if (view.lifecycle.length === 0 && view.turns.length === 0) {
    return (
      <div className="activity-empty-state">
        <div className="activity-empty-mark" aria-hidden="true">A</div>
        <div>
          <div className="activity-empty-title">Agent activity will appear here</div>
          <div className="activity-empty-copy">Thinking, tool calls, outputs, and verification stay out of the conversation and remain inspectable here.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="activity-tab activity-tab-grouped">
      <div className="activity-stream scroll" ref={scrollRef} onScroll={handleScroll}>
        {view.lifecycle.length > 0 && (
          <div className="activity-lifecycle">
            {view.lifecycle.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`activity-life-row ${entry.status}${selectedActivityId === entry.id ? " active" : ""}`}
                onClick={() => onSelectActivity(entry.id)}
              >
                <span className="activity-life-node" aria-hidden="true" />
                <span className="activity-life-label">{activityTitle(entry)}</span>
                <span className="activity-life-detail">{activityPreview(entry)}</span>
                <span className="activity-life-time">{formatTime(entry.timestamp)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="activity-turns">
          {view.turns.map((turn) => (
            <section
              key={turn.id}
              className={`activity-turn-card ${turn.status}${turn.entries.some((entry) => entry.id === selectedActivityId) ? " active" : ""}`}
            >
              <button
                type="button"
                className="activity-turn-head"
                onClick={() => onSelectActivity(turn.thinking?.id ?? turn.tools[0]?.id ?? turn.entries[0].id)}
              >
                <span className={`activity-turn-marker activity-turn-marker--${turn.status}`} aria-hidden="true" />
                <span className="activity-turn-index">t{turn.index}</span>
                <span className="activity-turn-title">{turn.title}</span>
                <span className="activity-turn-stats">{turn.tokensLabel} tok&nbsp; {turn.durationLabel}</span>
              </button>

              {turn.thinking && (
                <button
                  type="button"
                  className={`activity-thinking-row${selectedActivityId === turn.thinking.id ? " active" : ""}`}
                  onClick={() => onSelectActivity(turn.thinking!.id)}
                >
                  <span className="activity-spark" aria-hidden="true">✦</span>
                  <span className="activity-thinking-label">Thinking</span>
                  <span className="activity-thinking-text">{activityPreview(turn.thinking)}</span>
                  <span className="activity-chevron" aria-hidden="true">›</span>
                </button>
              )}

              <div className="activity-tool-list">
                {turn.tools.map((entry) => {
                  const tool = getToolMeta(entry);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={`activity-tool-row ${entry.status}${selectedActivityId === entry.id ? " active" : ""}`}
                      onClick={() => onSelectActivity(entry.id)}
                    >
                      <span className={`activity-tool-mark ${tool.cls}`}>{tool.label}</span>
                      <span className="activity-tool-kind">{tool.kind}</span>
                      <span className="activity-tool-title">{activityTitle(entry)}</span>
                      <span className="activity-tool-duration">{entry.status === "running" ? "running" : estimateDuration(entry)}</span>
                      <span className="activity-chevron" aria-hidden="true">›</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
      {!isNearBottom && (
        <button className="activity-jump-latest" type="button" onClick={handleJumpToLatest}>
          Jump to latest
        </button>
      )}
    </div>
  );
}

function deriveActivityView(activityLog: ActivityEntry[]): ActivityView {
  const lifecycle: ActivityEntry[] = [];
  const turns: ActivityTurn[] = [];
  let buffer: ActivityEntry[] = [];

  function flushTurn() {
    if (buffer.length === 0) return;
    const entries = buffer;
    const tools = entries.filter((entry) => entry.kind === "tool_call");
    const thinking = entries.find((entry) => entry.kind === "thinking") ?? null;
    const turn: ActivityTurn = {
      id: entries[0].id,
      index: turns.length + 1,
      title: summarizeTurn(entries),
      entries,
      thinking,
      tools,
      status: entries.some((entry) => entry.status === "running")
        ? "running"
        : entries.some((entry) => entry.status === "error")
          ? "error"
          : "success",
      tokensLabel: estimateTokens(entries),
      durationLabel: estimateTurnDuration(entries),
    };
    turns.push(turn);
    buffer = [];
  }

  for (const entry of activityLog) {
    if (entry.kind === "thinking" || entry.kind === "tool_call") {
      buffer.push(entry);
      continue;
    }

    flushTurn();
    lifecycle.push(entry);
  }
  flushTurn();

  return {
    lifecycle,
    turns,
    selectable: [...lifecycle, ...turns.flatMap((turn) => turn.entries)],
  };
}

function summarizeTurn(entries: ActivityEntry[]): string {
  const firstTool = entries.find((entry) => entry.kind === "tool_call" && entry.tool);
  if (firstTool?.tool?.summary) return humanizeSummary(firstTool.tool.summary);
  const thinking = entries.find((entry) => entry.kind === "thinking")?.thinking?.text;
  if (thinking) return thinking.replace(/\s+/g, " ").trim().slice(0, 70);
  return "Agent turn";
}

function humanizeSummary(summary: string): string {
  if (/^(read|list|search|find)\b/i.test(summary)) return "Explore repo structure";
  if (/^(edit|write|replace)\b/i.test(summary)) return "Apply code changes";
  if (/^(run|bash|command)\b/i.test(summary)) return "Run command";
  return summary;
}

function activityPreview(entry: ActivityEntry): string {
  if (entry.kind === "tool_call") return entry.tool?.result || entry.tool?.args || entry.tool?.name || "";
  if (entry.kind === "thinking") return entry.thinking?.text.replace(/\s+/g, " ").trim() || "";
  if (entry.kind === "event") return entry.event?.detail || "";
  return entry.phase?.label || "";
}

function activityTitle(entry: ActivityEntry): string {
  if (entry.kind === "tool_call") return entry.tool?.summary || entry.tool?.name || "Tool call";
  if (entry.kind === "thinking") return entry.thinking?.text?.slice(0, 90).trim() || "Assistant stream";
  if (entry.kind === "event") return entry.event?.label || "Event";
  return entry.phase?.label || "Activity";
}

function getToolMeta(entry: ActivityEntry): { cls: string; label: string; kind: string } {
  const name = entry.tool?.name.toLowerCase() ?? "";
  if (name.includes("read") || name.includes("view")) return { cls: "read", label: "R", kind: "READ" };
  if (name.includes("write") || name.includes("edit") || name.includes("replace")) return { cls: "write", label: "W", kind: "EDIT" };
  if (name.includes("grep") || name.includes("search") || name.includes("find")) return { cls: "grep", label: "G", kind: "SEARCH" };
  if (name.includes("list") || name.includes("ls")) return { cls: "ls", label: "L", kind: "LIST" };
  if (name.includes("bash") || name.includes("command") || name.includes("run")) return { cls: "bash", label: "$", kind: "RUN" };
  return { cls: "agent", label: "A", kind: "TOOL" };
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function estimateTokens(entries: ActivityEntry[]): string {
  const tokens = Math.max(0.8, entries.length * 0.42);
  return tokens >= 1 ? tokens.toFixed(1) : tokens.toFixed(1);
}

function estimateTurnDuration(entries: ActivityEntry[]): string {
  const first = entries[0]?.timestamp;
  const last = entries.at(-1)?.timestamp;
  if (!first || !last || last <= first) return `${Math.max(1, entries.length * 2)}s`;
  return `${Math.max(1, Math.round((last - first) / 1000))}s`;
}

function estimateDuration(entry: ActivityEntry): string {
  if (entry.kind !== "tool_call") return "";
  return entry.status === "success" ? "120ms" : entry.status;
}
