import { describe, expect, it } from "vitest";
import { reduceAnnotations } from "../session-store";
import { findTextOffset, diffAnnotations } from "../../hooks/use-annotation-highlighter";
import type { AnnotationThread, AnnotationReply } from "@codevil/shared";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const anchor = {
  startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 0 },
  endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 5 },
  text: "hello",
  blockId: "block-10-20",
  sourceLine: 3,
};

const author = { id: "usr_1", name: "Alice" };

function makeThread(id: string, overrides?: Partial<AnnotationThread>): AnnotationThread {
  return {
    id,
    run_id: "run_abc",
    round: 1,
    anchor,
    author,
    comment: `Comment from ${id}`,
    status: "open",
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeReply(id: string, overrides?: Partial<AnnotationReply>): AnnotationReply {
  return {
    id,
    author,
    comment: `Reply ${id}`,
    created_at: "2024-01-01T01:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// reduceAnnotations — annotation_created
// ---------------------------------------------------------------------------

describe("reduceAnnotations: annotation_created", () => {
  it("appends a new annotation thread", () => {
    const thread = makeThread("t1");
    const result = reduceAnnotations([], {
      type: "annotation_created",
      annotation: thread,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(thread);
  });

  it("appends multiple threads in order", () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const after1 = reduceAnnotations([], { type: "annotation_created", annotation: t1 });
    const after2 = reduceAnnotations(after1, { type: "annotation_created", annotation: t2 });
    expect(after2.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("dedupes by id — ignores annotation if id already present", () => {
    const t1 = makeThread("t1");
    const t1Dup = makeThread("t1", { comment: "different comment" });
    const after1 = reduceAnnotations([], { type: "annotation_created", annotation: t1 });
    const after2 = reduceAnnotations(after1, { type: "annotation_created", annotation: t1Dup });
    expect(after2).toHaveLength(1);
    expect(after2[0].comment).toBe("Comment from t1");
  });

  it("returns the same array reference when nothing changes (dedupe no-op)", () => {
    const t1 = makeThread("t1");
    const state = [t1];
    const result = reduceAnnotations(state, { type: "annotation_created", annotation: t1 });
    expect(result).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// reduceAnnotations — annotation_replied
// ---------------------------------------------------------------------------

describe("reduceAnnotations: annotation_replied", () => {
  it("appends a reply to the correct thread", () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const state = [t1, t2];
    const reply = makeReply("r1");
    const result = reduceAnnotations(state, {
      type: "annotation_replied",
      thread_id: "t1",
      reply,
    });
    expect(result[0].replies).toHaveLength(1);
    expect(result[0].replies![0]).toBe(reply);
    // t2 unchanged
    expect(result[1]).toBe(t2);
  });

  it("creates the replies array when it was absent", () => {
    const t1 = makeThread("t1"); // no replies field
    const reply = makeReply("r1");
    const result = reduceAnnotations([t1], {
      type: "annotation_replied",
      thread_id: "t1",
      reply,
    });
    expect(result[0].replies).toEqual([reply]);
  });

  it("dedupes replies by id", () => {
    const t1 = makeThread("t1", { replies: [makeReply("r1")] });
    const result = reduceAnnotations([t1], {
      type: "annotation_replied",
      thread_id: "t1",
      reply: makeReply("r1", { comment: "duplicate" }),
    });
    // Same array reference — no change
    expect(result[0].replies).toHaveLength(1);
    expect(result[0].replies![0].comment).toBe("Reply r1");
  });

  it("returns identity when duplicate reply would not mutate", () => {
    const reply = makeReply("r1");
    const t1 = makeThread("t1", { replies: [reply] });
    const state = [t1];
    const result = reduceAnnotations(state, {
      type: "annotation_replied",
      thread_id: "t1",
      reply,
    });
    expect(result).toBe(state);
  });

  it("unknown thread — returns current unchanged (same reference)", () => {
    const state = [makeThread("t1")];
    const result = reduceAnnotations(state, {
      type: "annotation_replied",
      thread_id: "UNKNOWN",
      reply: makeReply("r1"),
    });
    expect(result).toBe(state);
  });

  it("does not mutate other threads when appending a reply", () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const state = [t1, t2];
    const result = reduceAnnotations(state, {
      type: "annotation_replied",
      thread_id: "t2",
      reply: makeReply("r1"),
    });
    expect(result[0]).toBe(t1); // same reference — not a copy
    expect(result[1]).not.toBe(t2); // new object
  });
});

// ---------------------------------------------------------------------------
// reduceAnnotations — annotation_withdrawn
// ---------------------------------------------------------------------------

describe("reduceAnnotations: annotation_withdrawn", () => {
  it("sets the thread's status to 'withdrawn'", () => {
    const t1 = makeThread("t1");
    const state = [t1];
    const result = reduceAnnotations(state, {
      type: "annotation_withdrawn",
      thread_id: "t1",
      withdrawn_by: author,
      withdrawn_at: "2024-01-02T00:00:00Z",
    });
    expect(result[0].status).toBe("withdrawn");
  });

  it("unknown thread — returns current unchanged (same reference)", () => {
    const state = [makeThread("t1")];
    const result = reduceAnnotations(state, {
      type: "annotation_withdrawn",
      thread_id: "UNKNOWN",
      withdrawn_by: author,
      withdrawn_at: "2024-01-02T00:00:00Z",
    });
    expect(result).toBe(state);
  });

  it("returns identity when thread already withdrawn", () => {
    const state = [makeThread("t1", { status: "withdrawn" })];
    const result = reduceAnnotations(state, {
      type: "annotation_withdrawn",
      thread_id: "t1",
      withdrawn_by: author,
      withdrawn_at: "2024-01-02T00:00:00Z",
    });
    expect(result).toBe(state);
  });

  it("only updates the targeted thread, preserving other thread references", () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const state = [t1, t2];
    const result = reduceAnnotations(state, {
      type: "annotation_withdrawn",
      thread_id: "t1",
      withdrawn_by: author,
      withdrawn_at: "2024-01-02T00:00:00Z",
    });
    expect(result[1]).toBe(t2);
  });
});

// ---------------------------------------------------------------------------
// reduceAnnotations — annotations_consumed
// ---------------------------------------------------------------------------

describe("reduceAnnotations: annotations_consumed", () => {
  it("sets status to 'consumed' for the listed thread ids", () => {
    const t1 = makeThread("t1");
    const t2 = makeThread("t2");
    const t3 = makeThread("t3");
    const state = [t1, t2, t3];
    const result = reduceAnnotations(state, {
      type: "annotations_consumed",
      run_id: "run_abc",
      round: 1,
      thread_ids: ["t1", "t3"],
    });
    expect(result[0].status).toBe("consumed");
    expect(result[1].status).toBe("open"); // t2 unchanged
    expect(result[2].status).toBe("consumed");
  });

  it("returns identity for empty thread_ids list", () => {
    const state = [makeThread("t1")];
    const result = reduceAnnotations(state, {
      type: "annotations_consumed",
      run_id: "run_abc",
      round: 1,
      thread_ids: [],
    });
    expect(result).toBe(state);
  });

  it("returns identity when all listed ids are already consumed", () => {
    const state = [makeThread("t1", { status: "consumed" })];
    const result = reduceAnnotations(state, {
      type: "annotations_consumed",
      run_id: "run_abc",
      round: 1,
      thread_ids: ["t1"],
    });
    expect(result).toBe(state);
  });

  it("unknown ids in thread_ids are silently ignored", () => {
    const state = [makeThread("t1")];
    const result = reduceAnnotations(state, {
      type: "annotations_consumed",
      run_id: "run_abc",
      round: 1,
      thread_ids: ["UNKNOWN"],
    });
    expect(result).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// reduceAnnotations — identity return on no-op events
// ---------------------------------------------------------------------------

describe("reduceAnnotations: identity return on unrelated events", () => {
  it("returns the same reference for unrelated event types", () => {
    const state = [makeThread("t1")];
    const result = reduceAnnotations(state, {
      type: "status",
      message: "some status",
    });
    expect(result).toBe(state);
  });

  it("returns empty array by reference for unrelated event on empty state", () => {
    const empty: AnnotationThread[] = [];
    const result = reduceAnnotations(empty, {
      type: "participant_joined",
      participant: author,
    });
    expect(result).toBe(empty);
  });
});

// ---------------------------------------------------------------------------
// New-revision reset (tested via the store's onEvent handler approach)
// ---------------------------------------------------------------------------
// The spec says to reset annotations in the onEvent handler when the revision
// identity changes. That path is exercised via the store itself, but we can
// verify the reducer is pure and doesn't wipe state on its own for
// plan_revision_frozen — the reset happens externally in onEvent.

describe("reduceAnnotations: plan_revision_frozen passthrough", () => {
  it("does NOT reset annotations by itself for plan_revision_frozen (reset is done externally)", () => {
    const t1 = makeThread("t1");
    const state = [t1];
    const result = reduceAnnotations(state, {
      type: "plan_revision_frozen",
      run_id: "run_new",
      round: 2,
      markdown: "# New plan",
      locked: false,
    });
    // The reducer itself returns current unchanged — the store's onEvent
    // handler is responsible for zeroing annotations before calling
    // reduceAnnotations on a new revision.
    expect(result).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// findTextOffset — pure helper
// ---------------------------------------------------------------------------

describe("findTextOffset", () => {
  it("returns the start offset of the needle in the haystack", () => {
    expect(findTextOffset("hello world", "world")).toBe(6);
  });

  it("returns 0 when needle is at the start", () => {
    expect(findTextOffset("hello world", "hello")).toBe(0);
  });

  it("returns -1 when needle is not found", () => {
    expect(findTextOffset("hello world", "xyz")).toBe(-1);
  });

  it("returns -1 for empty needle", () => {
    expect(findTextOffset("hello world", "")).toBe(-1);
  });

  it("returns -1 for empty haystack", () => {
    expect(findTextOffset("", "hello")).toBe(-1);
  });

  it("is case-sensitive", () => {
    expect(findTextOffset("Hello World", "hello")).toBe(-1);
    expect(findTextOffset("Hello World", "Hello")).toBe(0);
  });

  it("returns the first occurrence when needle appears multiple times", () => {
    expect(findTextOffset("ababab", "ab")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diffAnnotations — pure reconcile set-diffing helper
// ---------------------------------------------------------------------------

describe("diffAnnotations", () => {
  it("open annotation not yet applied → appears in toApply", () => {
    const t1 = makeThread("t1"); // status: "open"
    const { toApply, toRemove } = diffAnnotations([t1], new Set());
    expect(toApply).toHaveLength(1);
    expect(toApply[0]).toBe(t1);
    expect(toRemove).toHaveLength(0);
  });

  it("applied annotation that is now withdrawn → appears in toRemove", () => {
    const t1 = makeThread("t1", { status: "withdrawn" });
    const { toApply, toRemove } = diffAnnotations([t1], new Set(["t1"]));
    expect(toApply).toHaveLength(0);
    expect(toRemove).toEqual(["t1"]);
  });

  it("applied annotation that is now consumed → appears in toRemove", () => {
    const t1 = makeThread("t1", { status: "consumed" });
    const { toApply, toRemove } = diffAnnotations([t1], new Set(["t1"]));
    expect(toApply).toHaveLength(0);
    expect(toRemove).toEqual(["t1"]);
  });

  it("applied annotation that is now absent from the list → appears in toRemove", () => {
    const { toApply, toRemove } = diffAnnotations([], new Set(["t1"]));
    expect(toApply).toHaveLength(0);
    expect(toRemove).toEqual(["t1"]);
  });

  it("withdrawn annotation never applied → neither toApply nor toRemove", () => {
    const t1 = makeThread("t1", { status: "withdrawn" });
    const { toApply, toRemove } = diffAnnotations([t1], new Set());
    expect(toApply).toHaveLength(0);
    expect(toRemove).toHaveLength(0);
  });

  it("idempotent: already-applied open annotation → empty/empty", () => {
    const t1 = makeThread("t1"); // status: "open"
    const { toApply, toRemove } = diffAnnotations([t1], new Set(["t1"]));
    expect(toApply).toHaveLength(0);
    expect(toRemove).toHaveLength(0);
  });

  it("dedupe: same id appearing only once even if passed as array", () => {
    const t1 = makeThread("t1");
    // appliedIds as array (the function accepts both Set and string[])
    const { toApply, toRemove } = diffAnnotations([t1], ["t1"]);
    expect(toApply).toHaveLength(0);
    expect(toRemove).toHaveLength(0);
  });

  it("accepts appliedIds as string[] in addition to Set", () => {
    const t1 = makeThread("t1");
    const { toApply, toRemove } = diffAnnotations([t1], []);
    expect(toApply).toHaveLength(1);
    expect(toApply[0]).toBe(t1);
    expect(toRemove).toHaveLength(0);
  });

  it("mixed scenario: one to apply, one to remove", () => {
    const t1 = makeThread("t1"); // open, not applied
    const t2 = makeThread("t2", { status: "withdrawn" }); // withdrawn, was applied
    const { toApply, toRemove } = diffAnnotations([t1, t2], new Set(["t2"]));
    expect(toApply).toHaveLength(1);
    expect(toApply[0]).toBe(t1);
    expect(toRemove).toEqual(["t2"]);
  });
});
