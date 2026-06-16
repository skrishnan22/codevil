import { describe, expect, it } from "vitest";
import type { AnnotationThread, ParticipantIdentity } from "@codevil/shared";
import type { QuestionViewModel } from "@/stores/session-store";
import {
  deriveSides,
  isConflictQuestion,
  openConflictsInOrder,
  orderByRaisedAt,
  shouldDisableChatInput,
} from "../conflict-question";

const ALICE: ParticipantIdentity = { id: "usr_alice", name: "Alice" };
const BOB: ParticipantIdentity = { id: "usr_bob", name: "Bob" };

function makeThread(id: string, overrides: Partial<AnnotationThread> = {}): AnnotationThread {
  return {
    id,
    run_id: "run_1",
    round: 0,
    anchor: {
      startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 0 },
      endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 1 },
      text: "annotation anchor text excerpt that is reasonably long",
      blockId: "blk_1",
      sourceLine: 1,
    },
    author: ALICE,
    comment: "comment body",
    status: "open",
    created_at: "2024-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeQuestion(
  id: string,
  overrides: Partial<QuestionViewModel> = {},
): QuestionViewModel {
  return {
    requestId: id,
    runId: "run_1",
    question: `Q ${id}`,
    options: [
      { id: "thread_a", label: "Side A" },
      { id: "thread_b", label: "Side B" },
    ],
    allowFreeform: false,
    allowMultiple: false,
    answerableBy: "decider",
    status: "open",
    raisedAt: 0,
    ...overrides,
  };
}

describe("isConflictQuestion", () => {
  it("returns true for a binary single-select question whose option ids match annotation threads", () => {
    const q = makeQuestion("q1");
    const ann = [makeThread("thread_a"), makeThread("thread_b")];
    expect(isConflictQuestion(q, ann)).toBe(true);
  });

  it("returns false when there is no options array", () => {
    const q = makeQuestion("q1", { options: undefined });
    expect(isConflictQuestion(q, [])).toBe(false);
  });

  it("returns false for not-exactly-two options", () => {
    const q1 = makeQuestion("q1", { options: [{ id: "thread_a", label: "A" }] });
    const q3 = makeQuestion("q3", {
      options: [
        { id: "thread_a", label: "A" },
        { id: "thread_b", label: "B" },
        { id: "thread_c", label: "C" },
      ],
    });
    const ann = [makeThread("thread_a"), makeThread("thread_b"), makeThread("thread_c")];
    expect(isConflictQuestion(q1, ann)).toBe(false);
    expect(isConflictQuestion(q3, ann)).toBe(false);
  });

  it("returns false when allowMultiple", () => {
    const q = makeQuestion("q1", { allowMultiple: true });
    const ann = [makeThread("thread_a"), makeThread("thread_b")];
    expect(isConflictQuestion(q, ann)).toBe(false);
  });

  it("returns false when an option id doesn't match a known annotation", () => {
    const q = makeQuestion("q1");
    const ann = [makeThread("thread_a")]; // thread_b missing
    expect(isConflictQuestion(q, ann)).toBe(false);
  });
});

describe("deriveSides", () => {
  it("resolves each side with author, createdAt, and a truncated anchor preview", () => {
    const q = makeQuestion("q1");
    const ann = [
      makeThread("thread_a", { author: ALICE, created_at: "2024-06-01T00:00:00.000Z" }),
      makeThread("thread_b", { author: BOB, created_at: "2024-06-02T00:00:00.000Z" }),
    ];
    const sides = deriveSides(q, ann);
    expect(sides).toHaveLength(2);
    expect(sides[0].author).toEqual(ALICE);
    expect(sides[0].createdAt).toBe("2024-06-01T00:00:00.000Z");
    expect(sides[0].anchorTextPreview?.length).toBeLessThanOrEqual(40);
    expect(sides[0].withdrawn).toBe(false);
    expect(sides[0].missing).toBe(false);
    expect(sides[1].author).toEqual(BOB);
  });

  it("marks missing=true when annotation is gone, keeping the option label/detail", () => {
    const q = makeQuestion("q1", {
      options: [
        { id: "thread_a", label: "Side A", detail: "fallback detail" },
        { id: "thread_b", label: "Side B" },
      ],
    });
    const ann = [makeThread("thread_a")];
    const sides = deriveSides(q, ann);
    expect(sides[1].missing).toBe(true);
    expect(sides[1].label).toBe("Side B");
    expect(sides[1].author).toBeNull();
    expect(sides[1].anchorTextPreview).toBeNull();
    expect(sides[0].missing).toBe(false);
  });

  it("marks withdrawn=true when annotation status is withdrawn", () => {
    const q = makeQuestion("q1");
    const ann = [
      makeThread("thread_a", { status: "withdrawn" }),
      makeThread("thread_b", { status: "open" }),
    ];
    const sides = deriveSides(q, ann);
    expect(sides[0].withdrawn).toBe(true);
    expect(sides[1].withdrawn).toBe(false);
  });

  it("returns [] when the question has no options", () => {
    const q = makeQuestion("q1", { options: undefined });
    expect(deriveSides(q, [])).toEqual([]);
  });

  it("truncates anchor text with ellipsis when longer than 40 chars", () => {
    const longText = "x".repeat(100);
    const q = makeQuestion("q1", {
      options: [
        { id: "thread_a", label: "A" },
        { id: "thread_b", label: "B" },
      ],
    });
    const ann = [
      makeThread("thread_a", { anchor: { ...makeThread("thread_a").anchor, text: longText } }),
      makeThread("thread_b"),
    ];
    const [a] = deriveSides(q, ann);
    expect(a.anchorTextPreview).not.toBe(longText);
    expect(a.anchorTextPreview?.endsWith("…")).toBe(true);
    expect(a.anchorTextPreview?.length).toBeLessThanOrEqual(40);
  });
});

describe("orderByRaisedAt", () => {
  it("sorts ascending by raisedAt", () => {
    const out = orderByRaisedAt([
      makeQuestion("q2", { raisedAt: 200 }),
      makeQuestion("q1", { raisedAt: 100 }),
      makeQuestion("q3", { raisedAt: 300 }),
    ]);
    expect(out.map((q) => q.requestId)).toEqual(["q1", "q2", "q3"]);
  });

  it("breaks ties on raisedAt by requestId lexicographically", () => {
    const out = orderByRaisedAt([
      makeQuestion("q_b", { raisedAt: 100 }),
      makeQuestion("q_a", { raisedAt: 100 }),
    ]);
    expect(out.map((q) => q.requestId)).toEqual(["q_a", "q_b"]);
  });

  it("does not mutate input", () => {
    const input = [
      makeQuestion("q2", { raisedAt: 200 }),
      makeQuestion("q1", { raisedAt: 100 }),
    ];
    orderByRaisedAt(input);
    expect(input.map((q) => q.requestId)).toEqual(["q2", "q1"]);
  });
});

describe("openConflictsInOrder", () => {
  it("returns only open conflict-shaped questions, ordered by raisedAt", () => {
    const ann = [makeThread("thread_a"), makeThread("thread_b")];
    const generic = makeQuestion("generic", {
      options: [{ id: "any", label: "anything" }],
      raisedAt: 50,
    });
    const answered = makeQuestion("ans", { status: "answered", raisedAt: 100 });
    const c1 = makeQuestion("c1", { raisedAt: 300 });
    const c2 = makeQuestion("c2", { raisedAt: 200 });
    const result = openConflictsInOrder([generic, answered, c1, c2], ann);
    expect(result.map((q) => q.requestId)).toEqual(["c2", "c1"]);
  });
});

describe("shouldDisableChatInput", () => {
  it("does not disable when there are no questions", () => {
    expect(shouldDisableChatInput([], [])).toEqual({ disabled: false });
  });

  it("does not disable for an open non-conflict question", () => {
    const q = makeQuestion("g", { options: [{ id: "x", label: "x" }] });
    expect(shouldDisableChatInput([q], []).disabled).toBe(false);
  });

  it("disables with a hint when at least one open conflict exists", () => {
    const q = makeQuestion("c");
    const ann = [makeThread("thread_a"), makeThread("thread_b")];
    const out = shouldDisableChatInput([q], ann);
    expect(out.disabled).toBe(true);
    expect(out.hint).toBe("Resolve the decision above to continue.");
  });

  it("does not disable when the conflict has been answered", () => {
    const q = makeQuestion("c", { status: "answered" });
    const ann = [makeThread("thread_a"), makeThread("thread_b")];
    expect(shouldDisableChatInput([q], ann).disabled).toBe(false);
  });
});
