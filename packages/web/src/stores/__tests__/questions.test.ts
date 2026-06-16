import { describe, expect, it } from "vitest";
import { parseRaisedAt, reduceQuestions } from "../session-store";
import type { QuestionViewModel } from "../session-store";
import type { DOToCLIEvent } from "@codevil/shared";

const PARTICIPANT = { id: "usr_1", name: "Alice" };

function makeRaisedEvent(
  requestId: string,
  overrides: Partial<{
    allow_freeform: boolean;
    allow_multiple: boolean;
    answerable_by: "decider" | "anyone";
    options: { id: string; label: string }[];
    context: string;
    raised_at: string;
  }> = {},
): DOToCLIEvent {
  return {
    type: "question_raised",
    request_id: requestId,
    run_id: "run_abc",
    question: `Question ${requestId}`,
    allow_freeform: overrides.allow_freeform ?? false,
    allow_multiple: overrides.allow_multiple ?? false,
    answerable_by: overrides.answerable_by ?? "decider",
    status: "open",
    raised_at: overrides.raised_at ?? "2024-01-01T00:00:00.000Z",
    ...(overrides.options ? { options: overrides.options } : {}),
    ...(overrides.context ? { context: overrides.context } : {}),
  };
}

function makeAnsweredEvent(requestId: string): DOToCLIEvent {
  return {
    type: "question_answered",
    request_id: requestId,
    option_ids: ["opt_1"],
    answered_by: PARTICIPANT,
    answered_at: "2024-01-01T00:00:00Z",
  };
}

describe("reduceQuestions", () => {
  it("appends a new question when question_raised", () => {
    const result = reduceQuestions([], makeRaisedEvent("req_1"));
    expect(result).toHaveLength(1);
    expect(result[0].requestId).toBe("req_1");
    expect(result[0].status).toBe("open");
    expect(result[0].question).toBe("Question req_1");
  });

  it("dedupes by request_id: ignores a second raised event with the same id", () => {
    const first = reduceQuestions([], makeRaisedEvent("req_1"));
    const second = reduceQuestions(first, makeRaisedEvent("req_1"));
    expect(second).toHaveLength(1);
    expect(second).toBe(first); // identity
  });

  it("tracks multiple questions independently", () => {
    const after1 = reduceQuestions([], makeRaisedEvent("req_1"));
    const after2 = reduceQuestions(after1, makeRaisedEvent("req_2"));
    expect(after2).toHaveLength(2);
    expect(after2[0].requestId).toBe("req_1");
    expect(after2[1].requestId).toBe("req_2");
  });

  it("sets status to answered and stores answer on question_answered", () => {
    const withQuestion = reduceQuestions([], makeRaisedEvent("req_1"));
    const result = reduceQuestions(withQuestion, makeAnsweredEvent("req_1"));
    expect(result[0].status).toBe("answered");
    expect(result[0].answer?.optionIds).toEqual(["opt_1"]);
    expect(result[0].answer?.answeredBy).toEqual(PARTICIPANT);
  });

  it("answered event on the correct question out of multiple", () => {
    const state = reduceQuestions(
      reduceQuestions([], makeRaisedEvent("req_1")),
      makeRaisedEvent("req_2"),
    );
    const result = reduceQuestions(state, makeAnsweredEvent("req_2"));
    expect(result[0].status).toBe("open");    // req_1 untouched
    expect(result[1].status).toBe("answered"); // req_2 answered
  });

  it("returns current by identity for unknown request_id on answered event", () => {
    const state: QuestionViewModel[] = [];
    const result = reduceQuestions(state, makeAnsweredEvent("nonexistent"));
    expect(result).toBe(state);
  });

  it("returns current by identity on already-answered question (no mutation)", () => {
    const withQ = reduceQuestions([], makeRaisedEvent("req_1"));
    const answered = reduceQuestions(withQ, makeAnsweredEvent("req_1"));
    const again = reduceQuestions(answered, makeAnsweredEvent("req_1"));
    expect(again).toBe(answered); // identity
  });

  it("returns current by identity on unrelated events", () => {
    const state: QuestionViewModel[] = [];
    const result = reduceQuestions(state, { type: "status", message: "hello" });
    expect(result).toBe(state);
  });

  it("maps all raised event fields to the view-model correctly", () => {
    const event = makeRaisedEvent("req_x", {
      allow_freeform: true,
      allow_multiple: true,
      answerable_by: "anyone",
      options: [{ id: "opt_a", label: "Option A" }],
      context: "some context",
    });
    const [vm] = reduceQuestions([], event);
    expect(vm.allowFreeform).toBe(true);
    expect(vm.allowMultiple).toBe(true);
    expect(vm.answerableBy).toBe("anyone");
    expect(vm.options).toEqual([{ id: "opt_a", label: "Option A" }]);
    expect(vm.context).toBe("some context");
    expect(vm.runId).toBe("run_abc");
  });

  it("derives raisedAt from raised_at on the event", () => {
    const event = makeRaisedEvent("req_t", { raised_at: "2024-06-01T12:34:56.000Z" });
    const [vm] = reduceQuestions([], event);
    expect(vm.raisedAt).toBe(Date.parse("2024-06-01T12:34:56.000Z"));
  });

  it("falls back to local time when raised_at is missing (legacy persisted event)", () => {
    // Simulate a legacy event by stripping raised_at after construction.
    const event = makeRaisedEvent("req_legacy");
    delete (event as { raised_at?: string }).raised_at;
    const before = Date.now();
    const [vm] = reduceQuestions([], event);
    const after = Date.now();
    expect(vm.raisedAt).toBeGreaterThanOrEqual(before);
    expect(vm.raisedAt).toBeLessThanOrEqual(after);
  });
});

describe("parseRaisedAt", () => {
  it("parses an ISO timestamp", () => {
    expect(parseRaisedAt("2024-01-01T00:00:00.000Z")).toBe(
      Date.parse("2024-01-01T00:00:00.000Z"),
    );
  });

  it("falls back to Date.now() when undefined", () => {
    const before = Date.now();
    const out = parseRaisedAt(undefined);
    const after = Date.now();
    expect(out).toBeGreaterThanOrEqual(before);
    expect(out).toBeLessThanOrEqual(after);
  });

  it("falls back to Date.now() when input is unparseable", () => {
    const before = Date.now();
    const out = parseRaisedAt("not-a-date");
    const after = Date.now();
    expect(out).toBeGreaterThanOrEqual(before);
    expect(out).toBeLessThanOrEqual(after);
  });
});
