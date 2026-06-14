import { describe, expect, it } from "vitest";
import { canAnswerQuestion } from "../annotation-predicates";

describe("canAnswerQuestion", () => {
  describe('answerableBy = "anyone"', () => {
    it("returns true when the user is signed in", () => {
      expect(canAnswerQuestion("anyone", "usr_1", null)).toBe(true);
    });

    it("returns true even when sessionCreatorId is set", () => {
      expect(canAnswerQuestion("anyone", "usr_1", "creator_1")).toBe(true);
    });

    it("returns false when currentUserId is null (not signed in)", () => {
      expect(canAnswerQuestion("anyone", null, null)).toBe(false);
    });

    it("returns false when currentUserId is null even if creatorId is set", () => {
      expect(canAnswerQuestion("anyone", null, "creator_1")).toBe(false);
    });
  });

  describe('answerableBy = "decider"', () => {
    it("returns true when currentUserId matches sessionCreatorId", () => {
      expect(canAnswerQuestion("decider", "creator_1", "creator_1")).toBe(true);
    });

    it("returns false when currentUserId does not match sessionCreatorId", () => {
      expect(canAnswerQuestion("decider", "usr_other", "creator_1")).toBe(false);
    });

    it("returns false when currentUserId is null", () => {
      expect(canAnswerQuestion("decider", null, "creator_1")).toBe(false);
    });

    it("returns false when sessionCreatorId is null (creator not yet known)", () => {
      expect(canAnswerQuestion("decider", "usr_1", null)).toBe(false);
    });

    it("returns false when both are null", () => {
      expect(canAnswerQuestion("decider", null, null)).toBe(false);
    });
  });
});
