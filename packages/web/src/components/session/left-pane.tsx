import { useSessionStore } from "@/stores/session-store";
import { TaskHeader } from "./task-header";
import { TaskMeta } from "./task-meta";
import { PhaseTracker } from "./phase-tracker";
import { PlanCard } from "./plan-card";
import { PlanRevisionView } from "./plan-revision-view";
import { ConversationPanel } from "./conversation-panel";
import { useEffect, useMemo, useRef } from "react";

export function LeftPane() {
  const { activityLog, messages } = useSessionStore();
  const planRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const files = collectFiles(activityLog);
  const cost = [...messages].reverse().find((message) => message.meta?.cost)?.meta?.cost;
  const totalTokens = cost ? cost.input_tokens + cost.output_tokens : 0;
  const inputPct = totalTokens > 0 ? (cost!.input_tokens / totalTokens) * 100 : 0;
  const outputPct = totalTokens > 0 ? (cost!.output_tokens / totalTokens) * 100 : 0;
  const focusEvent = useMemo(() => {
    const latestImportant = [...messages]
      .reverse()
      .find((message) =>
        message.variant === "plan" ||
        message.variant === "verification_failed" ||
        message.variant === "error" ||
        message.variant === "complete"
      );

    if (!latestImportant) return null;
    return {
      id: latestImportant.id,
      target: latestImportant.variant === "plan" ? "plan" : "conversation",
    };
  }, [messages]);

  useEffect(() => {
    if (!focusEvent) return;
    const target = focusEvent.target === "plan" ? planRef.current : conversationRef.current;
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusEvent]);

  return (
    <div className="leftpane scroll">
      <div className="leftpane-inner">
        <TaskHeader />
        <TaskMeta />
        <PhaseTracker />
        <div ref={planRef}>
          <PlanCard />
        </div>
        <PlanRevisionView />
        <div ref={conversationRef}>
          <ConversationPanel />
        </div>
        
        <div className="section-header">
          <div className="subhead">
            <span className="subhead-label">Files touched</span>
            <span className="subhead-meta">
              {files.filter((file) => file.mode === "read").length} read &middot;{" "}
              {files.filter((file) => file.mode === "write").length} written
            </span>
          </div>
          <div className="files-list">
            {files.length === 0 ? (
              <div className="detail-empty">
                <span className="detail-empty-text">No files touched yet</span>
              </div>
            ) : (
              files.map((file) => (
                <div className="file-row" key={`${file.mode}:${file.path}`}>
                  <span className={`file-kind ${file.mode}`}>{file.mode === "read" ? "R" : "W"}</span>
                  <span className="file-path">{file.path}</span>
                  <span className="file-stat">{file.mode === "read" ? "read" : "write"}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="section-header">
          <div className="subhead">
            <span className="subhead-label">Usage</span>
            <span className="subhead-meta">{cost ? `$${cost.total_cost_usd.toFixed(4)}` : "$0.00"}</span>
          </div>
          <div className="cost-bar">
            <div className="cost-bar-in" style={{ width: `${inputPct}%` }}></div>
            <div className="cost-bar-out" style={{ width: `${outputPct}%` }}></div>
          </div>
          <div className="cost-legend">
            <span><span className="lg-dot lg-in"></span>Input {cost?.input_tokens.toLocaleString() ?? 0}</span>
            <span><span className="lg-dot lg-out"></span>Output {cost?.output_tokens.toLocaleString() ?? 0}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface FileTouch {
  path: string;
  mode: "read" | "write";
}

function collectFiles(activityLog: ReturnType<typeof useSessionStore.getState>["activityLog"]): FileTouch[] {
  const files = new Map<string, FileTouch>();

  for (const entry of activityLog) {
    if (entry.kind !== "tool_call" || !entry.tool) continue;
    const args = parseArgs(entry.tool.args);
    const path = readPath(args);
    if (!path) continue;

    const mode = isWriteTool(entry.tool.name) ? "write" : "read";
    files.set(`${mode}:${path}`, { path, mode });
  }

  return [...files.values()].slice(0, 8);
}

function parseArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {};
  try {
    const parsed = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readPath(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path", "filePath", "target_file"]) {
    if (typeof args[key] === "string") return args[key];
  }
  return null;
}

function isWriteTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.includes("write") || normalized.includes("edit") || normalized.includes("replace");
}
