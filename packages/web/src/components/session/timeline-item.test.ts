import { describe, expect, it } from "vitest";
import { getTimelineMessagePresentation } from "./TimelineItem";

describe("timeline message presentation", () => {
  it("renders human messages with participant identity", () => {
    expect(getTimelineMessagePresentation({
      id: "msg_1",
      role: "user",
      variant: "text",
      content: "hello",
      timestamp: 1,
      actor: "Alice",
    })).toMatchObject({
      kind: "human",
      sender: "Alice",
      avatarLabel: "A",
    });
  });

  it("renders assistant replies as Codevil", () => {
    expect(getTimelineMessagePresentation({
      id: "msg_2",
      role: "assistant",
      variant: "text",
      content: "done",
      timestamp: 1,
    })).toMatchObject({
      kind: "agent",
      sender: "Codevil",
      avatarLabel: "C",
    });
  });

  it("renders system statuses as compact notices without an avatar", () => {
    expect(getTimelineMessagePresentation({
      id: "msg_3",
      role: "system",
      variant: "status",
      content: "Sandbox process started.",
      timestamp: 1,
    })).toMatchObject({
      kind: "system",
      sender: "System",
      avatarLabel: null,
    });
  });
});
