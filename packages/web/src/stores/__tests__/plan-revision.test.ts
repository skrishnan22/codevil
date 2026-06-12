import { describe, expect, it } from "vitest";
import { reducePlanRevision } from "../session-store";
import { blockIdForNode } from "../../components/session/plan-revision-view";

// ---------------------------------------------------------------------------
// blockIdForNode helper
// ---------------------------------------------------------------------------

describe("blockIdForNode", () => {
  // ── offset-present path ──────────────────────────────────────────────────

  it("uses character offsets when present", () => {
    const node = {
      position: {
        start: { line: 5, column: 1, offset: 40 },
        end: { line: 5, column: 20, offset: 59 },
      },
    };
    expect(blockIdForNode(node)).toBe("block-40-59");
  });

  it("is deterministic: same node always yields the same id (offset path)", () => {
    const node = {
      position: {
        start: { line: 3, column: 1, offset: 10 },
        end: { line: 3, column: 15, offset: 24 },
      },
    };
    expect(blockIdForNode(node)).toBe(blockIdForNode(node));
  });

  it("produces distinct ids for same-start-line nodes that differ in span (offset path)", () => {
    // Simulates: a loose-list `li` and its child `p` both start on line 3
    // but their source spans differ.
    const outerLi = {
      position: {
        start: { line: 3, column: 1, offset: 10 },
        end: { line: 3, column: 40, offset: 49 },
      },
    };
    const innerP = {
      position: {
        start: { line: 3, column: 3, offset: 12 },
        end: { line: 3, column: 38, offset: 47 },
      },
    };
    // Both share start.line = 3; ids must still be distinct.
    expect(outerLi.position.start.line).toBe(innerP.position.start.line);
    expect(blockIdForNode(outerLi)).not.toBe(blockIdForNode(innerP));
  });

  // ── fallback path (no offset) ────────────────────────────────────────────

  it("falls back to line:column span when offsets are absent", () => {
    const node = {
      position: {
        start: { line: 5, column: 1 },
        end: { line: 5, column: 20 },
      },
    };
    expect(blockIdForNode(node)).toBe("block-5:1-5:20");
  });

  it("is deterministic: same node always yields the same id (fallback path)", () => {
    const node = {
      position: {
        start: { line: 7, column: 1 },
        end: { line: 7, column: 30 },
      },
    };
    expect(blockIdForNode(node)).toBe(blockIdForNode(node));
  });

  it("produces distinct ids for same-start-line nodes that differ in span (fallback path)", () => {
    // A blockquote and its first-child p both start at line 2, column 1.
    // The blockquote ends later, so the spans differ.
    const blockquote = {
      position: {
        start: { line: 2, column: 1 },
        end: { line: 4, column: 1 },
      },
    };
    const childP = {
      position: {
        start: { line: 2, column: 3 },
        end: { line: 2, column: 40 },
      },
    };
    expect(blockIdForNode(blockquote)).not.toBe(blockIdForNode(childP));
  });

  it("produces different ids for different line/column spans", () => {
    const a = {
      position: {
        start: { line: 3, column: 1 },
        end: { line: 3, column: 20 },
      },
    };
    const b = {
      position: {
        start: { line: 4, column: 1 },
        end: { line: 4, column: 20 },
      },
    };
    expect(blockIdForNode(a)).not.toBe(blockIdForNode(b));
  });

  // ── no-position graceful fallback ────────────────────────────────────────

  it("returns null when position is absent", () => {
    expect(blockIdForNode({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reducePlanRevision
// ---------------------------------------------------------------------------

describe("reducePlanRevision", () => {
  it("sets revision state when plan_revision_frozen arrives with markdown", () => {
    const result = reducePlanRevision(null, {
      type: "plan_revision_frozen",
      run_id: "run_abc",
      round: 1,
      markdown: "# My Plan\n\nDo the thing.",
      locked: false,
      created_at: "2024-01-01T00:00:00Z",
      revision_id: "rev_1",
    });

    expect(result).not.toBeNull();
    expect(result!.runId).toBe("run_abc");
    expect(result!.round).toBe(1);
    expect(result!.markdown).toBe("# My Plan\n\nDo the thing.");
    expect(result!.locked).toBe(false);
    expect(result!.createdAt).toBe("2024-01-01T00:00:00Z");
    expect(result!.revisionId).toBe("rev_1");
  });

  it("defaults locked to false and optional fields to null when absent", () => {
    const result = reducePlanRevision(null, {
      type: "plan_revision_frozen",
      run_id: "run_xyz",
      round: 0,
      markdown: "# Plan",
    });

    expect(result!.locked).toBe(false);
    expect(result!.createdAt).toBeNull();
    expect(result!.revisionId).toBeNull();
  });

  it("preserves existing markdown but updates locked on a lock-only signal (no markdown)", () => {
    const existing = {
      runId: "run_abc",
      round: 1,
      markdown: "# My Plan",
      locked: false,
      createdAt: "2024-01-01T00:00:00Z",
      revisionId: "rev_1",
    };

    const result = reducePlanRevision(existing, {
      type: "plan_revision_frozen",
      run_id: "run_abc",
      round: 1,
      locked: true,
      // no markdown field
    });

    expect(result).not.toBeNull();
    expect(result!.markdown).toBe("# My Plan");
    expect(result!.locked).toBe(true);
    expect(result!.runId).toBe("run_abc");
  });

  it("returns null unchanged when no existing revision and lock-only signal arrives", () => {
    const result = reducePlanRevision(null, {
      type: "plan_revision_frozen",
      run_id: "run_abc",
      round: 1,
      locked: true,
      // no markdown
    });

    expect(result).toBeNull();
  });

  it("ignores unrelated events and returns current unchanged", () => {
    const existing = {
      runId: "run_abc",
      round: 1,
      markdown: "# My Plan",
      locked: false,
      createdAt: null,
      revisionId: null,
    };

    const result = reducePlanRevision(existing, {
      type: "status",
      message: "Some status update",
    });

    expect(result).toBe(existing); // Same reference — not a copy
  });

  it("ignores unrelated events when current is null", () => {
    const result = reducePlanRevision(null, {
      type: "session_created",
      session_id: "ses_1",
    });

    expect(result).toBeNull();
  });
});
