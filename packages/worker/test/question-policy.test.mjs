import assert from "node:assert/strict";
import test from "node:test";

import { isDecider, canAnswerQuestion } from "../dist/question-policy.js";

// --- isDecider ---

test("isDecider returns false when userId is null", () => {
  assert.equal(isDecider(null, "creator_123", "owner"), false);
});

test("isDecider returns false when userId is empty string", () => {
  assert.equal(isDecider("", "creator_123", "owner"), false);
});

test("isDecider returns true when userId matches creatorId", () => {
  assert.equal(isDecider("creator_123", "creator_123", null), true);
});

test("isDecider returns false when userId does not match creatorId", () => {
  assert.equal(isDecider("other_user", "creator_123", "owner"), false);
});

test("isDecider ignores role when creatorId is set and userId matches", () => {
  assert.equal(isDecider("creator_123", "creator_123", "member"), true);
});

test("isDecider ignores role when creatorId is set and userId does not match", () => {
  assert.equal(isDecider("owner_user", "creator_123", "owner"), false);
});

test("isDecider falls back to role=owner when creatorId is null", () => {
  assert.equal(isDecider("any_user", null, "owner"), true);
});

test("isDecider falls back to role=admin when creatorId is null", () => {
  assert.equal(isDecider("any_user", null, "admin"), true);
});

test("isDecider falls back to role=member → false when creatorId is null", () => {
  assert.equal(isDecider("any_user", null, "member"), false);
});

test("isDecider falls back to role=null → false when creatorId is null", () => {
  assert.equal(isDecider("any_user", null, null), false);
});

test("isDecider falls back to role when creatorId is undefined", () => {
  assert.equal(isDecider("any_user", undefined, "owner"), true);
  assert.equal(isDecider("any_user", undefined, "member"), false);
});

test("isDecider falls back to role when creatorId is empty string", () => {
  // empty string is falsy — treated as no creator on record
  assert.equal(isDecider("any_user", "", "owner"), true);
  assert.equal(isDecider("any_user", "", "member"), false);
});

// --- canAnswerQuestion ---

test('canAnswerQuestion with "anyone" always returns true regardless of userId', () => {
  assert.equal(canAnswerQuestion("anyone", null, "creator_123", "owner"), true);
  assert.equal(canAnswerQuestion("anyone", "some_user", "creator_123", "member"), true);
  assert.equal(canAnswerQuestion("anyone", "creator_123", null, null), true);
});

test('canAnswerQuestion with "decider" returns true for matching creator', () => {
  assert.equal(canAnswerQuestion("decider", "creator_123", "creator_123", "member"), true);
});

test('canAnswerQuestion with "decider" returns false for non-creator user', () => {
  assert.equal(canAnswerQuestion("decider", "other_user", "creator_123", "owner"), false);
});

test('canAnswerQuestion with "decider" returns false when userId is null', () => {
  assert.equal(canAnswerQuestion("decider", null, "creator_123", "owner"), false);
});

test('canAnswerQuestion with "decider" falls back to owner role when no creator', () => {
  assert.equal(canAnswerQuestion("decider", "any_user", null, "owner"), true);
  assert.equal(canAnswerQuestion("decider", "any_user", null, "admin"), true);
  assert.equal(canAnswerQuestion("decider", "any_user", null, "member"), false);
});

test('canAnswerQuestion with "decider" + no creator + null role → false', () => {
  assert.equal(canAnswerQuestion("decider", "any_user", null, null), false);
});
