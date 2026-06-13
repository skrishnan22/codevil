import { describe, expect, it } from "vitest";
import { canWithdraw, canReply, openThreadsSorted, compareThreads, canSendToAgent, sendToAgentLabel } from "../annotation-predicates";
import type { AnnotationThread } from "@codevil/shared";

function makeThread(overrides: Partial<AnnotationThread> = {}): AnnotationThread {
  return {
    id: "thread_1",
    run_id: "run_1",
    round: 0,
    anchor: {
      startMeta: { parentTagName: "p", parentIndex: 0, textOffset: 0 },
      endMeta: { parentTagName: "p", parentIndex: 0, textOffset: 5 },
      text: "hello",
      blockId: "block_1",
      sourceLine: 5,
    },
    author: { id: "usr_1", name: "Alice" },
    comment: "Looks good",
    status: "open",
    created_at: "2024-01-01T00:00:00Z",
    replies: [],
    ...overrides,
  };
}

describe("canWithdraw", () => {
  it("returns true for the author of an open unlocked thread", () => {
    const thread = makeThread({ status: "open" });
    expect(canWithdraw(thread, "usr_1", false)).toBe(true);
  });

  it("returns false when the user is not the author", () => {
    const thread = makeThread({ status: "open" });
    expect(canWithdraw(thread, "usr_2", false)).toBe(false);
  });

  it("returns false when currentUserId is null", () => {
    const thread = makeThread({ status: "open" });
    expect(canWithdraw(thread, null, false)).toBe(false);
  });

  it("returns false when the revision is locked", () => {
    const thread = makeThread({ status: "open" });
    expect(canWithdraw(thread, "usr_1", true)).toBe(false);
  });

  it("returns false when the thread is withdrawn", () => {
    const thread = makeThread({ status: "withdrawn" });
    expect(canWithdraw(thread, "usr_1", false)).toBe(false);
  });

  it("returns false when the thread is consumed", () => {
    const thread = makeThread({ status: "consumed" });
    expect(canWithdraw(thread, "usr_1", false)).toBe(false);
  });
});

describe("canReply", () => {
  it("returns true when not locked", () => {
    expect(canReply(false)).toBe(true);
  });

  it("returns false when locked", () => {
    expect(canReply(true)).toBe(false);
  });
});

describe("compareThreads", () => {
  it("sorts by sourceLine ascending", () => {
    const a = makeThread({ id: "a", anchor: { ...makeThread().anchor, sourceLine: 10 }, created_at: "2024-01-01T00:00:00Z" });
    const b = makeThread({ id: "b", anchor: { ...makeThread().anchor, sourceLine: 2 }, created_at: "2024-01-01T00:00:00Z" });
    expect(compareThreads(a, b)).toBeGreaterThan(0);
    expect(compareThreads(b, a)).toBeLessThan(0);
  });

  it("breaks ties by created_at ascending", () => {
    const a = makeThread({ id: "a", created_at: "2024-01-02T00:00:00Z" });
    const b = makeThread({ id: "b", created_at: "2024-01-01T00:00:00Z" });
    expect(compareThreads(a, b)).toBeGreaterThan(0);
    expect(compareThreads(b, a)).toBeLessThan(0);
  });

  it("returns 0 for equal line and created_at", () => {
    const a = makeThread({ id: "a" });
    const b = makeThread({ id: "b" });
    expect(compareThreads(a, b)).toBe(0);
  });
});

describe("openThreadsSorted", () => {
  it("filters to open threads for the given run/round only", () => {
    const threads: AnnotationThread[] = [
      makeThread({ id: "t1", run_id: "run_1", round: 0, status: "open" }),
      makeThread({ id: "t2", run_id: "run_1", round: 1, status: "open" }),
      makeThread({ id: "t3", run_id: "run_2", round: 0, status: "open" }),
      makeThread({ id: "t4", run_id: "run_1", round: 0, status: "withdrawn" }),
      makeThread({ id: "t5", run_id: "run_1", round: 0, status: "consumed" }),
    ];
    const result = openThreadsSorted(threads, "run_1", 0);
    expect(result.map((t) => t.id)).toEqual(["t1"]);
  });

  it("sorts open threads by sourceLine then created_at", () => {
    const base = makeThread().anchor;
    const threads: AnnotationThread[] = [
      makeThread({
        id: "c",
        anchor: { ...base, sourceLine: 3 },
        created_at: "2024-01-01T00:00:01Z",
        status: "open",
      }),
      makeThread({
        id: "a",
        anchor: { ...base, sourceLine: 1 },
        created_at: "2024-01-01T00:00:00Z",
        status: "open",
      }),
      makeThread({
        id: "b",
        anchor: { ...base, sourceLine: 3 },
        created_at: "2024-01-01T00:00:00Z",
        status: "open",
      }),
    ];
    const result = openThreadsSorted(threads, "run_1", 0);
    expect(result.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});

describe("canSendToAgent", () => {
  it("returns true when there are open annotations and no note (unlocked)", () => {
    expect(canSendToAgent(2, "", false)).toBe(true);
  });

  it("returns true when there are no annotations but a non-empty note (unlocked)", () => {
    expect(canSendToAgent(0, "Please simplify step 3", false)).toBe(true);
  });

  it("returns true when there are both open annotations and a note (unlocked)", () => {
    expect(canSendToAgent(1, "extra note", false)).toBe(true);
  });

  it("returns false when there are no annotations and the note is empty (unlocked)", () => {
    expect(canSendToAgent(0, "", false)).toBe(false);
  });

  it("returns false when there are no annotations and the note is whitespace-only (unlocked)", () => {
    expect(canSendToAgent(0, "   ", false)).toBe(false);
  });

  it("returns false when locked, even with open annotations", () => {
    expect(canSendToAgent(3, "", true)).toBe(false);
  });

  it("returns false when locked, even with a non-empty note", () => {
    expect(canSendToAgent(0, "some note", true)).toBe(false);
  });
});

describe("sendToAgentLabel", () => {
  it("returns generic label when count is 0", () => {
    expect(sendToAgentLabel(0)).toBe("Send to agent");
  });

  it("uses singular form for exactly 1 comment", () => {
    expect(sendToAgentLabel(1)).toBe("Send 1 comment to agent");
  });

  it("uses plural form for 2 or more comments", () => {
    expect(sendToAgentLabel(2)).toBe("Send 2 comments to agent");
    expect(sendToAgentLabel(10)).toBe("Send 10 comments to agent");
  });
});
