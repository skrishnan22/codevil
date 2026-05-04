import { useSessionStore } from "@/stores/session-store";
import { useCallback, useEffect, useRef, useState } from "react";

interface TurnsListProps {
  filter: string;
  selectedCallId: string | null;
  onSelectCall: (id: string) => void;
}

export function TurnsList({ filter, selectedCallId, onSelectCall }: TurnsListProps) {
  const { activityLog, sessionPhase } = useSessionStore();
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [followLatest, setFollowLatest] = useState(true);

  const isRunning = sessionPhase === "planning" || sessionPhase === "executing";

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

  useEffect(() => {
    if (followLatest) scrollToLatest("smooth");
  }, [activityLog.length, filter, followLatest, scrollToLatest]);

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    setFollowLatest(atBottom);
  }

  function handleJumpToLatest() {
    setFollowLatest(true);
    scrollToLatest();
  }

  const getToolIcon = (name: string) => {
    if (name.includes('read') || name.includes('view_file')) return { cls: 'read', char: 'R' };
    if (name.includes('write') || name.includes('replace')) return { cls: 'write', char: 'W' };
    if (name.includes('list') || name.includes('ls')) return { cls: 'ls', char: 'L' };
    if (name.includes('grep') || name.includes('search')) return { cls: 'grep', char: 'G' };
    if (name.includes('bash') || name.includes('command')) return { cls: 'bash', char: '$' };
    return { cls: 'agent', char: '✦' };
  };

  const filteredLog = activityLog.filter(entry => {
    if (filter === "all") return entry.kind === "tool_call" || entry.kind === "thinking";
    if (filter === "agent") return entry.kind === "thinking";
    
    if (entry.kind === "tool_call" && entry.tool) {
      const toolType = getToolIcon(entry.tool.name).cls;
      return toolType === filter;
    }
    return false;
  });

  return (
    <div className="insp-list scroll" ref={listRef} onScroll={handleScroll}>
      <div className="insp-turn">
        <div className="insp-turn-head">
          <div className={`insp-turn-bullet ${isRunning ? 'pulse' : ''}`}></div>
          <div className="insp-turn-label">Execution Trace</div>
          <div className="insp-turn-meta">{activityLog.length} events</div>
        </div>
        
        <div className="insp-calls">
          {filteredLog.map(entry => {
            if (entry.kind === "thinking") {
              const isSelected = selectedCallId === entry.id;
              return (
                <button 
                  key={entry.id} 
                  className={`insp-call ${isSelected ? 'insp-call-sel' : ''}`}
                  onClick={() => onSelectCall(entry.id)}
                >
                  <div className="tool-icon agent">✦</div>
                  <div className="insp-call-tool">AGENT</div>
                  <div className="insp-call-title">Thinking process...</div>
                  <div className="insp-call-dur"></div>
                </button>
              );
            }

            if (entry.kind === "tool_call" && entry.tool) {
              const icon = getToolIcon(entry.tool.name);
              const isSelected = selectedCallId === entry.id;
              const isCallRunning = entry.status === "running";
              
              return (
                <button 
                  key={entry.id} 
                  className={`insp-call ${isSelected ? 'insp-call-sel' : ''} ${isCallRunning ? 'row-active' : ''}`}
                  onClick={() => onSelectCall(entry.id)}
                >
                  <div className={`tool-icon ${icon.cls}`}>{icon.char}</div>
                  <div className="insp-call-tool">{icon.cls}</div>
                  <div className="insp-call-title">{entry.tool.summary || entry.tool.name}</div>
                  <div className="insp-call-dur">
                    {isCallRunning ? "run" : entry.status === "error" ? "err" : "ok"}
                  </div>
                </button>
              );
            }

            return null;
          })}
          
          {filteredLog.length === 0 && (
             <div className="detail-empty" style={{ padding: '20px' }}>
               <span className="detail-empty-text">No matching traces</span>
             </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      {!followLatest && (
        <button className="jump-latest" type="button" onClick={handleJumpToLatest}>
          Jump to latest
        </button>
      )}
    </div>
  );
}
