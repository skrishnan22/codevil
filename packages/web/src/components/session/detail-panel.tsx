import React from "react";
import { useSessionStore } from "@/stores/session-store";

interface DetailPanelProps {
  selectedCallId: string | null;
}

export function DetailPanel({ selectedCallId }: DetailPanelProps) {
  const { activityLog } = useSessionStore();

  if (!selectedCallId) {
    return (
      <div className="insp-detail scroll">
        <div className="detail-empty">
          <div className="detail-empty-glyph">⌖</div>
          <div className="detail-empty-text">Click any tool call to inspect</div>
        </div>
      </div>
    );
  }

  const entry = activityLog.find(e => e.id === selectedCallId);

  if (!entry) return null;

  const getToolIcon = (name: string) => {
    if (name.includes('read') || name.includes('view_file')) return { cls: 'read', char: 'R' };
    if (name.includes('write') || name.includes('replace')) return { cls: 'write', char: 'W' };
    if (name.includes('list') || name.includes('ls')) return { cls: 'ls', char: 'L' };
    if (name.includes('grep') || name.includes('search')) return { cls: 'grep', char: 'G' };
    if (name.includes('bash') || name.includes('command')) return { cls: 'bash', char: '$' };
    return { cls: 'agent', char: '✦' };
  };

  if (entry.kind === "thinking") {
    return (
      <div className="insp-detail scroll">
        <div className="detail">
          <div className="detail-head">
            <div className="detail-crumbs">trace &rsaquo; {entry.id.slice(-6)}</div>
            <div className="detail-titlerow">
              <div className="tool-icon tool-icon-lg agent">✦</div>
              <div>
                <h3 className="detail-title">Agent Thinking</h3>
                <div className="detail-sub">Internal reasoning</div>
              </div>
            </div>
          </div>
          
          <div className="detail-section">
            <div className="detail-section-head">
              <span className="detail-section-label">Reasoning</span>
              <span className="detail-section-eyebrow">why this action</span>
            </div>
            <div className="detail-section-body reasoning">
              <span className="reasoning-quote">&ldquo;</span>
              {entry.thinking?.text || "..."}
              {entry.status === "running" && <span className="cursor-blink"></span>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (entry.kind === "tool_call" && entry.tool) {
    const icon = getToolIcon(entry.tool.name);
    
    // Parse arguments safely
    let argsObj: any = {};
    try {
      if (entry.tool.args) argsObj = JSON.parse(entry.tool.args);
    } catch(e) {}

    const isRead = icon.cls === 'read';
    const output = entry.tool.error || entry.tool.result || "Waiting for output...";

    return (
      <div className="insp-detail scroll">
        <div className="detail">
          <div className="detail-head">
            <div className="detail-crumbs">trace &rsaquo; {entry.id.slice(-6)}</div>
            <div className="detail-titlerow">
              <div className={`tool-icon tool-icon-lg ${icon.cls}`}>{icon.char}</div>
              <div style={{ minWidth: 0 }}>
                <h3 className="detail-title">{entry.tool.summary || entry.tool.name}</h3>
                <div className="detail-sub">{entry.tool.name} &middot; {entry.status}</div>
              </div>
              <div className="detail-stats">
                <div className="chip">
                  <span className={`dot ${entry.status === 'running' ? 'info pulse' : entry.status === 'success' ? 'ok' : 'err'}`}></span>
                  {entry.status}
                </div>
              </div>
            </div>
          </div>
          
          <div className="detail-section">
            <div className="detail-section-head">
              <span className="detail-section-label">Input</span>
              <span className="detail-section-eyebrow">arguments</span>
            </div>
            <div className="detail-section-body kv-grid">
              {Object.entries(argsObj).map(([key, value]) => (
                <React.Fragment key={key}>
                  <div className="kv-key">{key}</div>
                  <div className="kv-val-c">{String(value)}</div>
                </React.Fragment>
              ))}
              {Object.keys(argsObj).length === 0 && <div className="muted">No arguments provided</div>}
            </div>
          </div>

          <div className="detail-section">
            <div className="detail-section-head">
              <span className="detail-section-label">Output</span>
              <span className="detail-section-eyebrow">{entry.tool.result ? 'result' : entry.tool.error ? 'error' : 'running...'}</span>
            </div>
            <div className="detail-section-body" style={{ padding: 0 }}>
               {isRead && entry.tool.result ? (
                 <div className="read-code">
                   {entry.tool.result.split("\n").map((line, index) => (
                     <div className="code-line" key={index}>
                       <span className="code-ln">{index + 1}</span>
                       <span className="code-text">{line || " "}</span>
                     </div>
                   ))}
                 </div>
               ) : (
                 <div style={{ padding: '12px', whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', fontSize: '11.5px', color: entry.status === "error" ? 'var(--err)' : 'var(--fg-2)' }}>
                   {output}
                 </div>
               )}
            </div>
          </div>

        </div>
      </div>
    );
  }

  return null;
}
