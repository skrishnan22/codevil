import { useSessionStore } from "@/stores/session-store";
import type { ActivityEntry } from "@/types";

const PHASES = [
  { id: "initializing", label: "Provision" },
  { id: "planning", label: "Plan" },
  { id: "awaiting_approval", label: "Review" },
  { id: "executing", label: "Execute" },
  { id: "completed", label: "Done" },
];

function getPhaseIndex(phase: string | null): number {
  switch (phase) {
    case "initializing": return 0;
    case "planning": return 1;
    case "awaiting_approval": return 2;
    case "executing": return 3;
    case "completed": return 4;
    case "failed": return 4;
    default: return -1;
  }
}

function getToolBadgeClass(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes("read") || n.includes("view_file") || n.includes("view")) return "read";
  if (n.includes("write") || n.includes("edit") || n.includes("replace")) return "write";
  if (n.includes("bash") || n.includes("command") || n.includes("run")) return "bash";
  if (n.includes("grep") || n.includes("search")) return "grep";
  if (n.includes("list") || n.includes("ls")) return "ls";
  return "";
}

function getToolLabel(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes("read") || n.includes("view_file") || n.includes("view")) return "READ";
  if (n.includes("write") || n.includes("edit") || n.includes("replace")) return "WRITE";
  if (n.includes("bash") || n.includes("command") || n.includes("run")) return "BASH";
  if (n.includes("grep") || n.includes("search")) return "GREP";
  if (n.includes("list") || n.includes("ls")) return "LS";
  return toolName.slice(0, 6).toUpperCase();
}

function findCurrentEntry(activityLog: ActivityEntry[]): ActivityEntry | null {
  // prefer running
  const running = [...activityLog].reverse().find((e) => e.status === "running");
  if (running) return running;
  // fallback: latest thinking or tool_call
  return (
    [...activityLog]
      .reverse()
      .find((e) => e.kind === "thinking" || e.kind === "tool_call") ?? null
  );
}

export function StatusStrip() {
  const { activityLog, sessionPhase } = useSessionStore();

  const current = findCurrentEntry(activityLog);
  const dotClass =
    sessionPhase === "planning" || sessionPhase === "executing"
      ? "running"
      : sessionPhase === "failed"
      ? "error"
      : sessionPhase === "completed"
      ? "ok"
      : "";

  const reasoning =
    current?.kind === "thinking"
      ? current.thinking?.text?.trim()
      : null;

  const hasTool = current?.kind === "tool_call" && current.tool;

  const currentPhaseIdx = getPhaseIndex(sessionPhase);
  const toolCalls = activityLog.filter((e) => e.kind === "tool_call").length;

  return (
    <div className="status-strip" aria-label="Current agent activity">
      {/* Reasoning row */}
      {reasoning || hasTool ? (
        <div className="status-strip-row">
          <div className={`status-strip-dot${dotClass ? ` ${dotClass}` : ""}${dotClass === "running" ? " pulse" : ""}`} />
          {reasoning ? (
            <div className="status-strip-reasoning">{reasoning}</div>
          ) : (
            <div className="status-strip-idle">Agent is working…</div>
          )}
        </div>
      ) : (
        <div className="status-strip-row">
          <div className="status-strip-dot" />
          <div className="status-strip-idle">
            {sessionPhase === "completed"
              ? "Session complete"
              : sessionPhase === "failed"
              ? "Session failed"
              : "Waiting for agent activity…"}
          </div>
        </div>
      )}

      {/* Tool call row */}
      {hasTool && current?.tool && (
        <div className="status-strip-tool-row" style={{ marginLeft: 18 }}>
          <span className={`status-strip-tool-badge ${getToolBadgeClass(current.tool.name)}`}>
            {getToolLabel(current.tool.name)}
          </span>
          <span className="status-strip-tool-summary">
            {current.tool.summary || current.tool.name}
          </span>
        </div>
      )}

      {/* Footer: phase progress */}
      <div className="status-strip-footer">
        <span className="status-strip-phase-label">
          {sessionPhase ?? "connecting"}
        </span>
        <div className="status-strip-phase-dots" aria-hidden="true">
          {PHASES.map((p, idx) => {
            const cls =
              idx < currentPhaseIdx
                ? "done"
                : idx === currentPhaseIdx
                ? "active"
                : "";
            return <div key={p.id} className={`status-strip-phase-dot${cls ? ` ${cls}` : ""}`} />;
          })}
        </div>
        {toolCalls > 0 && (
          <span className="status-strip-step-count">{toolCalls} steps</span>
        )}
      </div>
    </div>
  );
}
