import { describe, expect, it } from "vitest";
import { reducePlanRevision } from "../session-store";
import { blockIdForLine, blockIdForNode } from "../../components/session/PlanRevisionView";

// ---------------------------------------------------------------------------
// blockIdForLine / blockIdForNode helper
// ---------------------------------------------------------------------------

describe("blockIdForLine", () => {
  it("returns a deterministic id based on the line number", () => {
    expect(blockIdForLine(1)).toBe("block-L1");
    expect(blockIdForLine(42)).toBe("block-L42");
  });

  it("produces the same output for the same input (stable across calls)", () => {
    expect(blockIdForLine(7)).toBe(blockIdForLine(7));
  });

  it("produces different output for different inputs", () => {
    expect(blockIdForLine(3)).not.toBe(blockIdForLine(4));
  });
});

describe("blockIdForNode", () => {
  it("returns the block id derived from the node start line", () => {
    const node = {
      position: {
        start: { line: 5, column: 1 },
        end: { line: 5, column: 20 },
      },
    };
    expect(blockIdForNode(node)).toBe("block-L5");
  });

  it("returns null when position is absent", () => {
    const node = {
      // no position property
    };
    expect(blockIdForNode(node)).toBeNull();
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
