import { describe, expect, it } from "vitest";
import {
  getActivityFollowStateAfterJump,
  getActivityFollowStateAfterScroll,
} from "./activity-scroll";

describe("activity scroll follow state", () => {
  it("stops following when the user scrolls away from the latest trace", () => {
    const state = getActivityFollowStateAfterScroll({
      distanceFromBottom: 220,
    });

    expect(state.isFollowingLatest).toBe(false);
    expect(state.isNearBottom).toBe(false);
  });

  it("resumes following when the user scrolls back near the latest trace", () => {
    const state = getActivityFollowStateAfterScroll({
      distanceFromBottom: 18,
    });

    expect(state.isFollowingLatest).toBe(true);
    expect(state.isNearBottom).toBe(true);
  });

  it("resumes following when the user jumps to the latest trace", () => {
    expect(getActivityFollowStateAfterJump()).toEqual({
      isFollowingLatest: true,
      isNearBottom: true,
    });
  });
});
