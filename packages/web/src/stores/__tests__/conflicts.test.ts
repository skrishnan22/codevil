import { describe, expect, it } from "vitest";
import { inferPhase, reduceConflicts, useSessionStore } from "../session-store";
import type { AnnotationConflict } from "@codevil/shared";

function makeConflict(id: string, overrides?: Partial<AnnotationConflict>): AnnotationConflict {
  return {
    id,
    run_id: "run_abc",
    round: 1,
    summary: `Conflict ${id}`,
    options: [
      { thread_id: "thread_1", gist: "Keep the current structure." },
      { thread_id: "thread_2", gist: "Split the work into phases." },
    ],
    status: "open",
    ...overrides,
  };
}

describe("reduceConflicts", () => {
  it("appends a newly raised conflict", () => {
    const conflict = makeConflict("conf_1");
    const result = reduceConflicts([], { type: "conflict_raised", conflict });
    expect(result).toEqual([conflict]);
  });

  it("updates an existing conflict when a replayed raised event differs", () => {
    const existing = makeConflict("conf_1");
    const replacement = makeConflict("conf_1", { summary: "Updated summary" });
    const result = reduceConflicts([existing], { type: "conflict_raised", conflict: replacement });
    expect(result).toEqual([replacement]);
  });

  it("marks a conflict resolved on conflict_resolved", () => {
    const existing = makeConflict("conf_1");
    const result = reduceConflicts([existing], {
      type: "conflict_resolved",
      conflict_id: "conf_1",
      resolved_by: { id: "usr_1", name: "Alice" },
      selected_thread_id: "thread_1",
    });
    expect(result[0].status).toBe("resolved");
  });

  it("clears conflicts after brief dispatch", () => {
    const result = reduceConflicts([makeConflict("conf_1")], {
      type: "brief_dispatched",
      run_id: "run_abc",
      from_round: 1,
      to_round: 2,
      brief_items: [{ instruction: "Refine section 2", source_thread_ids: ["thread_1"] }],
    });
    expect(result).toEqual([]);
  });
});

describe("inferPhase conflict states", () => {
  it("moves the session into awaiting_resolution when a conflict is raised", () => {
    expect(
      inferPhase(
        { type: "conflict_raised", conflict: makeConflict("conf_1") },
        "refining",
      ),
    ).toBe("awaiting_resolution");
  });

  it("returns refining after a brief dispatch", () => {
    expect(
      inferPhase(
        {
          type: "brief_dispatched",
          run_id: "run_abc",
          from_round: 1,
          to_round: 2,
          brief_items: [{ instruction: "Refine section 2", source_thread_ids: ["thread_1"] }],
        },
        "awaiting_resolution",
      ),
    ).toBe("refining");
  });
});

describe("session creator lifecycle", () => {
  it("clears a stale session creator when connecting to a different session", () => {
    useSessionStore.setState({
      sessionId: "session_old",
      wsUrl: "ws://old.example.test",
      messages: [],
      activityLog: [],
      participants: [],
      sessionPhase: null,
      cursor: 0,
      connectionStatus: "connected",
      error: null,
      planApproved: false,
      preview: {
        status: "idle",
        url: null,
        command: null,
        port: null,
        error: null,
        apps: [],
        selectedAppKey: null,
        reloadRevision: 0,
        outputLines: [],
      },
      planRevision: null,
      annotations: [],
      conflicts: [],
      selectedAnnotationId: null,
      currentUserId: "usr_1",
      sessionCreatorId: "creator_old",
    });

    useSessionStore.getState().connectToSession(
      { endpoint: "http://example.test" },
      "session_new",
      "ws://new.example.test",
    );

    expect(useSessionStore.getState().sessionCreatorId).toBeNull();
  });
});
