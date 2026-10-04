import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@/types";
import {
  deriveStatus,
  filterOtherActiveSessions,
  isActiveSession,
} from "@/lib/session-status";

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s1",
    title: "Fix the badge",
    repo: "acme/app",
    room_state: "ready",
    sandbox_state: "ready",
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
    last_event_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("deriveStatus", () => {
  it("reports running for queued/thinking/executing runs", () => {
    for (const state of ["queued", "thinking", "executing"] as const) {
      expect(deriveStatus(makeSession({ active_run_state: state }))).toBe("running");
    }
  });

  it("reports review for awaiting_approval/verifying/publishing runs", () => {
    for (const state of ["awaiting_approval", "verifying", "publishing"] as const) {
      expect(deriveStatus(makeSession({ active_run_state: state }))).toBe("review");
    }
  });

  it("reports done for completed runs", () => {
    expect(deriveStatus(makeSession({ active_run_state: "completed" }))).toBe("done");
  });

  it("reports failed for failed room, sandbox, or run state", () => {
    expect(deriveStatus(makeSession({ room_state: "failed" }))).toBe("failed");
    expect(deriveStatus(makeSession({ sandbox_state: "failed" }))).toBe("failed");
    expect(deriveStatus(makeSession({ active_run_state: "failed" }))).toBe("failed");
  });

  it("reports running while the sandbox is provisioning", () => {
    expect(deriveStatus(makeSession({ sandbox_state: "provisioning" }))).toBe("running");
  });

  it("reports idle once nothing is in flight", () => {
    expect(deriveStatus(makeSession())).toBe("idle");
  });
});

describe("isActiveSession", () => {
  it("treats running and review sessions as active", () => {
    expect(isActiveSession(makeSession({ active_run_state: "executing" }))).toBe(true);
    expect(isActiveSession(makeSession({ active_run_state: "awaiting_approval" }))).toBe(true);
    expect(isActiveSession(makeSession({ active_run_state: "verifying" }))).toBe(true);
  });

  it("excludes done, failed, archived, and idle sessions", () => {
    expect(isActiveSession(makeSession({ active_run_state: "completed" }))).toBe(false);
    expect(isActiveSession(makeSession({ active_run_state: "failed" }))).toBe(false);
    expect(isActiveSession(makeSession({ room_state: "failed" }))).toBe(false);
    expect(isActiveSession(makeSession({ room_state: "archived" }))).toBe(false);
    expect(isActiveSession(makeSession())).toBe(false);
  });
});

describe("filterOtherActiveSessions", () => {
  it("returns only active sessions besides the current one, newest first", () => {
    const running = makeSession({
      id: "s-running",
      active_run_state: "executing",
      last_event_at: "2026-09-14T10:00:00.000Z",
    });
    const review = makeSession({
      id: "s-review",
      active_run_state: "awaiting_approval",
      last_event_at: "2026-09-14T12:00:00.000Z",
    });
    const current = makeSession({
      id: "s-current",
      active_run_state: "executing",
      last_event_at: "2026-09-14T11:00:00.000Z",
    });
    const done = makeSession({
      id: "s-done",
      active_run_state: "completed",
      last_event_at: "2026-09-14T13:00:00.000Z",
    });

    const result = filterOtherActiveSessions([done, review, current, running], "s-current");
    expect(result.map((session) => session.id)).toEqual(["s-review", "s-running"]);
  });

  it("returns an empty list when there are no other active sessions", () => {
    const done = makeSession({ id: "s-done", active_run_state: "completed" });
    expect(filterOtherActiveSessions([done], "s-done")).toEqual([]);
  });
});