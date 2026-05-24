import { describe, expect, it } from "vitest";
import {
  getTimelineFollowStateAfterJump,
  getTimelineFollowStateAfterScroll,
} from "./timeline-scroll";

describe("timeline scroll follow state", () => {
  it("stops following when the user scrolls away from the latest activity", () => {
    const state = getTimelineFollowStateAfterScroll({
      distanceFromBottom: 360,
    });

    expect(state.isFollowingLatest).toBe(false);
    expect(state.isNearBottom).toBe(false);
  });

  it("does not resume following just because new content arrives while the user is reading history", () => {
    const state = getTimelineFollowStateAfterScroll({
      distanceFromBottom: 420,
    });

    expect(state.isFollowingLatest).toBe(false);
    expect(state.isNearBottom).toBe(false);
  });

  it("resumes following when the user scrolls back to the bottom threshold", () => {
    const state = getTimelineFollowStateAfterScroll({
      distanceFromBottom: 24,
    });

    expect(state.isFollowingLatest).toBe(true);
    expect(state.isNearBottom).toBe(true);
  });

  it("resumes following when the user jumps to latest", () => {
    expect(getTimelineFollowStateAfterJump()).toEqual({
      isFollowingLatest: true,
      isNearBottom: true,
    });
  });
});
