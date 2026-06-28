import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { addCost, zeroCost } from "@codevil/shared";
import { useSessionStore } from "@/stores/session-store";
import { loadStoredSession } from "@/lib/session-summary";
import { Logo } from "@/components/brand/logo";
import { SettingsDialog } from "@/components/settings-dialog";

type StatusVariant =
  | "running"
  | "connecting"
  | "failed"
  | "disconnected"
  | "done"
  | "idle";

function sumMessageCosts(messages: ReturnType<typeof useSessionStore.getState>["messages"]) {
  let total = zeroCost();
  let found = false;
  for (const message of messages) {
    if (message.meta?.cost) {
      total = addCost(total, message.meta.cost);
      found = true;
    }
  }
  return found ? total : null;
}

export function SessionRail() {
  const { sessionId, sessionPhase, connectionStatus, messages, sessionCostTotal, stopSession } =
    useSessionStore();
  const storedSession = loadStoredSession(sessionId);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const messageCost = sumMessageCosts(messages);
  const costInfo = sessionCostTotal !== null
    ? {
        total_cost_usd: sessionCostTotal,
        input_tokens: messageCost?.input_tokens ?? 0,
        output_tokens: messageCost?.output_tokens ?? 0,
      }
    : messageCost;
  const cost = costInfo ? `$${costInfo.total_cost_usd.toFixed(4)}` : "$0.00";
  const totalTokens = costInfo
    ? costInfo.input_tokens + costInfo.output_tokens
    : 0;
  const tokensLabel = `${formatCompact(totalTokens)} tok`;
  const elapsed = formatElapsed(messages[0]?.timestamp);

  // Status precedence — must match session-top-bar.tsx exactly.
  const isRunning =
    sessionPhase === "planning" || sessionPhase === "executing";
  const isDone = sessionPhase === "completed";
  const isError = sessionPhase === "failed" || connectionStatus === "error";

  let statusVariant: StatusVariant = "idle";
  let statusText = "idle";
  let pulse = false;

  if (isError) {
    statusVariant = "failed";
    statusText = "Failed";
  } else if (connectionStatus === "connecting") {
    statusVariant = "connecting";
    statusText = "connecting";
    pulse = true;
  } else if (connectionStatus === "disconnected") {
    statusVariant = "disconnected";
    statusText = "disconnected";
  } else if (isRunning) {
    statusVariant = "running";
    statusText = "running";
    pulse = true;
  } else if (isDone) {
    statusVariant = "done";
    statusText = "done";
  } else {
    statusVariant = "idle";
    statusText = "idle";
  }

  // Connection dot on avatar.
  let connDot: { variant: "amber" | "red"; pulse: boolean } | null = null;
  if (connectionStatus === "connecting") {
    connDot = { variant: "amber", pulse: true };
  } else if (
    connectionStatus === "disconnected" ||
    connectionStatus === "error"
  ) {
    connDot = { variant: "red", pulse: false };
  }

  const sessionIdLabel = sessionId
    ? sessionId.length > 14
      ? `${sessionId.slice(0, 14)}…`
      : sessionId
    : "loading…";

  function handleStop() {
    if (
      window.confirm(
        "Stop the sandbox container? This will end the session and tear down the preview.",
      )
    ) {
      stopSession();
    }
  }

  return (
    <header className="session-rail">
      <Link to="/" className="session-rail-brand" aria-label="Codevil home">
        <Logo />
      </Link>
      <span className="session-rail-sep">/</span>
      <span
        className="session-rail-session-id"
        title={sessionId ?? undefined}
      >
        {sessionIdLabel}
      </span>
      {storedSession?.repo && (
        <>
          <span className="session-rail-sep">·</span>
          <span className="session-rail-repo">{storedSession.repo}</span>
        </>
      )}

      <span className="session-rail-spacer" />

      <div className="session-rail-stats" aria-label="Session stats">
        <b className="session-rail-stat-num">{cost}</b>
        <span className="session-rail-stat-sep">·</span>
        <b className="session-rail-stat-num">{tokensLabel}</b>
        <span className="session-rail-stat-sep">·</span>
        <b className="session-rail-stat-num">{elapsed}</b>
      </div>

      <span
        className={`session-rail-status-pill session-rail-status-pill--${statusVariant}`}
      >
        <span
          className={`session-rail-status-dot${pulse ? " session-rail-status-dot--pulse" : ""}`}
          aria-hidden="true"
        />
        {statusText}
      </span>

      <button
        type="button"
        className="session-rail-stop"
        onClick={handleStop}
        disabled={connectionStatus !== "connected" || sessionId === null}
        title="Stop the sandbox container immediately"
      >
        <span aria-hidden="true">■</span> Stop
      </button>

      <span className="session-rail-divider" aria-hidden="true" />

      <Link to="/" className="session-rail-nav">
        Sessions
      </Link>
      <button
        type="button"
        className="session-rail-nav"
        onClick={() => setSettingsOpen(true)}
      >
        Settings
      </button>

      <span className="session-rail-avatar" aria-label="Current user">
        K
        {connDot && (
          <span
            className={`session-rail-conn-dot session-rail-conn-dot--${connDot.variant}${connDot.pulse ? " session-rail-conn-dot--pulse" : ""}`}
            aria-hidden="true"
          />
        )}
      </span>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}

function formatCompact(value: number): string {
  if (value >= 1000)
    return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2).replace(/\.0+$/, "")}k`;
  return String(value);
}

function formatElapsed(startedAt: number | undefined): string {
  if (!startedAt) return "0s";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
