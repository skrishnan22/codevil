import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { loadConfig } from "@/lib/config";
import { listSessions } from "@/lib/api-client";
import {
  deriveStatus,
  filterOtherActiveSessions,
  STATUS_LABEL,
} from "@/lib/session-status";
import type { SessionSummary } from "@/types";

const SIDEBAR_COLLAPSED_KEY = "codevil_session_sidebar_collapsed";
const REFRESH_INTERVAL_MS = 30_000;

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function persistCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* The sidebar still works; only persistence is lost. */
  }
}

interface SessionSidebarProps {
  sessionId: string;
}

export function SessionSidebar({ sessionId }: SessionSidebarProps) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [activeSessions, setActiveSessions] = useState<SessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const fetchingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (fetchingRef.current) return;
    const config = loadConfig();
    if (!config) return;
    fetchingRef.current = true;
    try {
      const result = await listSessions(config);
      setActiveSessions(filterOtherActiveSessions(result.sessions, sessionId));
      setLoaded(true);
    } catch {
      // Keep the last-known list; a transient failure should not clear the sidebar.
    } finally {
      fetchingRef.current = false;
    }
  }, [sessionId]);

  useEffect(() => {
    // Refetch when switching sessions so "current" is excluded correctly.
    setActiveSessions([]);
    setLoaded(false);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_INTERVAL_MS);

    function refreshOnVisible() {
      if (document.visibilityState === "visible") void refresh();
    }
    document.addEventListener("visibilitychange", refreshOnVisible);
    window.addEventListener("focus", refreshOnVisible);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshOnVisible);
      window.removeEventListener("focus", refreshOnVisible);
    };
  }, [refresh]);

  function handleToggle() {
    setCollapsed((current) => {
      persistCollapsed(!current);
      return !current;
    });
  }

  const activeCount = activeSessions.length;

  if (collapsed) {
    return (
      <aside className="session-sidebar session-sidebar--collapsed" aria-label="Active sessions">
        <button
          type="button"
          className="session-sidebar-toggle"
          onClick={handleToggle}
          aria-expanded={false}
          aria-label="Expand active sessions sidebar"
          title="Expand active sessions sidebar"
        >
          <ChevronIcon direction="right" />
        </button>
        {activeCount > 0 && (
          <span className="session-sidebar-count-badge" title={`${activeCount} active ${activeCount === 1 ? "session" : "sessions"}`}>
            {activeCount}
          </span>
        )}
      </aside>
    );
  }

  return (
    <aside className="session-sidebar" aria-label="Active sessions">
      <div className="session-sidebar-head">
        <span className="session-sidebar-title">Active sessions</span>
        <span className="session-sidebar-count">{activeCount}</span>
        <button
          type="button"
          className="session-sidebar-toggle"
          onClick={handleToggle}
          aria-expanded={true}
          aria-label="Collapse active sessions sidebar"
          title="Collapse active sessions sidebar"
        >
          <ChevronIcon direction="left" />
        </button>
      </div>

      <nav className="session-sidebar-nav" aria-label="Other active sessions">
        {loaded && activeCount === 0 ? (
          <div className="session-sidebar-empty">
            No other active sessions.
          </div>
        ) : (
          <ul className="session-sidebar-list">
            {activeSessions.map((session) => (
              <SessionSidebarItem key={session.id} session={session} />
            ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}

function SessionSidebarItem({ session }: { session: SessionSummary }) {
  const status = deriveStatus(session);
  return (
    <li>
      <Link
        to="/session/$id"
        params={{ id: session.id }}
        className="session-sidebar-item"
      >
        <span className="session-sidebar-item-head">
          <span className="session-sidebar-item-title" title={session.title}>
            {session.title}
          </span>
          <span className={`home-status-pill ${status}`}>
            <span className="home-status-dot" aria-hidden="true" />
            {STATUS_LABEL[status]}
          </span>
        </span>
        <span className="session-sidebar-item-sub">
          <span className="session-sidebar-item-repo">{session.repo}</span>
          <span className="session-sidebar-item-time">
            {formatRelativeTime(session.last_event_at)}
          </span>
        </span>
      </Link>
    </li>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: direction === "left" ? "rotate(180deg)" : undefined }}
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}