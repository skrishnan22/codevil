import { useState } from "react";
import type { ActivityEntry } from "@/types";

interface TraceGroupData {
  id: string;
  entries: ActivityEntry[];
  summary: { reads: number; writes: number; thinking: number; bash: number; other: number };
}

interface TraceGroupProps {
  group: TraceGroupData;
  onOpenActivity?: (id: string) => void;
}

function getToolBadgeClass(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes("read") || n.includes("view") || n.includes("grep") || n.includes("search") || n.includes("list") || n.includes("ls")) return "read";
  if (n.includes("write") || n.includes("edit") || n.includes("replace")) return "write";
  if (n.includes("bash") || n.includes("command") || n.includes("run")) return "bash";
  return "";
}

function getToolLabel(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes("read") || n.includes("view_file") || n.includes("view")) return "R";
  if (n.includes("write") || n.includes("edit") || n.includes("replace")) return "W";
  if (n.includes("bash") || n.includes("command") || n.includes("run")) return "$";
  if (n.includes("grep") || n.includes("search")) return "G";
  if (n.includes("list") || n.includes("ls")) return "L";
  return "•";
}

function getThinkingPreview(entries: ActivityEntry[]): string | null {
  const thinking = [...entries]
    .reverse()
    .find((entry) => entry.kind === "thinking" && entry.thinking?.text?.trim());
  if (!thinking?.thinking?.text) return null;
  return thinking.thinking.text.replace(/\s+/g, " ").trim();
}

export function TraceGroup({ group, onOpenActivity }: TraceGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const { entries, summary } = group;
  const thinkingPreview = getThinkingPreview(entries);

  const chips: { label: string; cls: string }[] = [];
  if (summary.reads > 0) chips.push({ label: `${summary.reads} read`, cls: "read" });
  if (summary.writes > 0) chips.push({ label: `${summary.writes} write`, cls: "write" });
  if (summary.bash > 0) chips.push({ label: `${summary.bash} bash`, cls: "bash" });
  if (summary.thinking > 0) chips.push({ label: `${summary.thinking} thinking`, cls: "agent" });
  if (summary.other > 0) chips.push({ label: `${summary.other} other`, cls: "" });

  return (
    <div className="trace-group">
      <div className="trace-group-header-row">
        <button
          id={`trace-group-${group.id}`}
          className="trace-group-header"
          onClick={() => setExpanded((v) => !v)}
          type="button"
          aria-expanded={expanded}
        >
          <span className="trace-group-count">{entries.length}</span>
          <span className="trace-group-summary">
            <span className="trace-group-summary-chips">
              {chips.map((chip) => (
                <span key={chip.label} className="trace-group-chip">
                  {chip.cls && (
                    <span className={`tool-icon ${chip.cls}`} aria-hidden="true">
                      {chip.cls === "read" ? "R" : chip.cls === "write" ? "W" : chip.cls === "bash" ? "$" : "A"}
                    </span>
                  )}
                  {chip.label}
                </span>
              ))}
            </span>
            {thinkingPreview && (
              <span className="trace-group-thinking-preview">{thinkingPreview}</span>
            )}
          </span>
          <svg
            className={`trace-group-chevron${expanded ? " open" : ""}`}
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {onOpenActivity && (
          <button
            type="button"
            className="trace-group-open-activity"
            onClick={() => onOpenActivity(group.id)}
            aria-label="Open activity details"
            title="Open in Activity"
          >
            Activity
          </button>
        )}
      </div>

      {expanded && (
        <div className="trace-group-calls">
          {entries.map((entry) => {
            if (entry.kind === "thinking") {
              return (
                <div key={entry.id} className="trace-call-row">
                  <span className="tool-icon agent" aria-hidden="true">A</span>
                  <span className="trace-call-type">stream</span>
                  <span className="trace-call-title">
                    {entry.thinking?.text?.slice(0, 80).trim() ?? "Assistant stream"}
                  </span>
                  <span className={`trace-call-status ${entry.status}`}>{entry.status}</span>
                </div>
              );
            }
            if (entry.kind === "tool_call" && entry.tool) {
              const cls = getToolBadgeClass(entry.tool.name);
              const label = getToolLabel(entry.tool.name);
              return (
                <div key={entry.id} className="trace-call-row">
                  <span className={`tool-icon ${cls}`} aria-hidden="true">{label}</span>
                  <span className="trace-call-type">{cls || "tool"}</span>
                  <span className="trace-call-title">
                    {entry.tool.summary || entry.tool.name}
                  </span>
                  <span className={`trace-call-status ${entry.status === "success" ? "ok" : entry.status}`}>
                    {entry.status === "success" ? "ok" : entry.status}
                  </span>
                </div>
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

export type { TraceGroupData };
