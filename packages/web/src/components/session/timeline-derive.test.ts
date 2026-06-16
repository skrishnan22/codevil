import { describe, expect, it } from "vitest";
import { deriveTimeline } from "./Timeline";
import type { ChatMessage } from "@/types";
import type { QuestionViewModel } from "@/stores/session-store";

function msg(id: string, ts: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: "assistant",
    variant: "text",
    content: `msg ${id}`,
    timestamp: ts,
    ...overrides,
  };
}

function q(id: string, raisedAt: number, overrides: Partial<QuestionViewModel> = {}): QuestionViewModel {
  return {
    requestId: id,
    runId: "run_1",
    question: `Q ${id}`,
    allowFreeform: false,
    allowMultiple: false,
    answerableBy: "decider",
    status: "open",
    raisedAt,
    ...overrides,
  };
}

describe("deriveTimeline + questions", () => {
  it("interleaves questions with messages by timestamp", () => {
    const items = deriveTimeline(
      [msg("m1", 100), msg("m2", 300)],
      [q("q1", 200)],
    );
    expect(items.map((i) => i.id)).toEqual(["msg-m1", "q-q1", "msg-m2"]);
  });

  it("places a question after a message at the same timestamp (messages win ties)", () => {
    const items = deriveTimeline([msg("m1", 100)], [q("q1", 100)]);
    expect(items.map((i) => i.id)).toEqual(["msg-m1", "q-q1"]);
  });

  it("orders multiple questions by their raisedAt", () => {
    const items = deriveTimeline(
      [],
      [q("q_late", 300), q("q_early", 100), q("q_mid", 200)],
    );
    expect(items.map((i) => i.id)).toEqual(["q-q_early", "q-q_mid", "q-q_late"]);
  });

  it("works with no questions (back-compat with previous deriveTimeline signature)", () => {
    const items = deriveTimeline([msg("m1", 1), msg("m2", 2)]);
    expect(items.map((i) => i.id)).toEqual(["msg-m1", "msg-m2"]);
  });

  it("keeps answered questions in the timeline at their raise time, not their answer time", () => {
    // The card collapses to a resolved one-liner but remains anchored to the
    // moment the question was raised.
    const items = deriveTimeline(
      [msg("m1", 100), msg("m2", 500)],
      [q("q1", 200, { status: "answered" })],
    );
    expect(items.map((i) => i.id)).toEqual(["msg-m1", "q-q1", "msg-m2"]);
    const questionItem = items.find((i) => i.type === "question");
    expect(questionItem).toBeDefined();
    if (questionItem?.type !== "question") throw new Error("expected question");
    expect(questionItem.data.status).toBe("answered");
  });
});
