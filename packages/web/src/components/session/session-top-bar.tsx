import { Link } from "@tanstack/react-router";
import { useSessionStore } from "@/stores/session-store";
import { loadStoredSession } from "@/lib/session-summary";
import { Logo } from "@/components/brand/logo";

export function SessionTopBar() {
  const { sessionId, sessionPhase, connectionStatus, messages, stopSession } = useSessionStore();
  const storedSession = loadStoredSession(sessionId);
  
  const costInfo = [...messages].reverse().find((message) => message.meta?.cost)?.meta?.cost;
  const cost = costInfo ? `$${costInfo.total_cost_usd.toFixed(4)}` : "$0.00";
  const tokens = costInfo
    ? `${formatCompact(costInfo.input_tokens)} → ${formatCompact(costInfo.output_tokens)}`
    : "0 → 0";
  const elapsed = formatElapsed(messages[0]?.timestamp);
  const model = messages.find((m) => m.meta?.model)?.meta?.model ?? null;
  
  // Status logic
  const isRunning = sessionPhase === "planning" || sessionPhase === "executing";
  const isDone = sessionPhase === "completed";
  const isError = sessionPhase === "failed" || connectionStatus === "error";
  
  let statusText = "connected";
  let statusClass = "dot idle";
  
  if (isError) {
    statusText = "failed";
    statusClass = "dot err";
  } else if (connectionStatus === "connecting") {
    statusText = "connecting";
    statusClass = "dot info pulse";
  } else if (connectionStatus === "disconnected") {
    statusText = "disconnected";
    statusClass = "dot idle";
  } else if (isRunning) {
    statusText = "running";
    statusClass = "dot info pulse";
  } else if (isDone) {
    statusText = "done";
    statusClass = "dot ok";
  }

  return (
    <>
      <header className="topbar session-global-topbar">
        <div className="topbar-left">
          <Link to="/" className="topbar-title">
            <Logo />
          </Link>
          {storedSession?.repo && (
            <>
              <span className="topbar-sep" />
              <span className="topbar-repo">{storedSession.repo}</span>
            </>
          )}
          <span className="topbar-sep">/</span>
          <span className="topbar-session">{sessionId ? sessionId.slice(0, 18) : "loading..."}</span>
        </div>

        <div className="topbar-right">
          <Link to="/" className="session-nav-link">Sessions</Link>
          <Link to="/" className="session-nav-link">Settings</Link>
          <span className="session-user-avatar" aria-label="Current user">K</span>
        </div>
      </header>

      <div className="room-status-strip">
        <div className="room-status-left">
          <div className={`room-run-pill ${statusText}`}>
            <span className={statusClass}></span>
            {statusText}
          </div>
          <span className="room-status-session">{sessionId ? sessionId.slice(0, 18) : "loading..."}</span>
          {model && <span className="room-status-model">{model}</span>}
        </div>
        <div className="room-status-right">
          <span className="room-stat"><span>COST</span>{cost}</span>
          <span className="room-stat"><span>TOKENS</span>{tokens}</span>
          <span className="room-stat"><span>ELAPSED</span>{elapsed}</span>
          <button
            type="button"
            className="room-stop-button"
            onClick={() => {
              if (window.confirm("Stop the sandbox container? This will end the session and tear down the preview.")) {
                stopSession();
              }
            }}
            disabled={connectionStatus !== "connected" || sessionId === null}
            title="Stop the sandbox container immediately"
          >
            <span aria-hidden="true" />
            Stop
          </button>
        </div>
      </div>
    </>
  );
}

function formatCompact(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2).replace(/\.0+$/, "")}k`;
  return String(value);
}

function formatElapsed(startedAt: number | undefined): string {
  if (!startedAt) return "0s";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
