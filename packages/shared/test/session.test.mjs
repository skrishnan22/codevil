import assert from "node:assert/strict";
import test from "node:test";

import {
  isTerminalState,
  isValidTransition,
  SESSION_STATES,
} from "../dist/index.js";

/** Documented transition matrix — update when `session.ts` transitions change. */
const ALLOWED_TRANSITIONS = {
  initializing: ["provisioning_sandbox", "failed"],
  provisioning_sandbox: ["cloning_repo", "failed", "timed_out"],
  cloning_repo: ["ready", "planning", "failed", "timed_out"],
  ready: ["planning", "executing", "failed", "timed_out"],
  planning: ["awaiting_approval", "ready", "failed", "timed_out"],
  awaiting_approval: ["refining", "executing", "ready", "failed", "timed_out"],
  refining: ["awaiting_approval", "ready", "failed", "timed_out"],
  executing: ["verifying", "ready", "failed", "timed_out"],
  verifying: ["retrying", "creating_pr", "ready", "failed", "timed_out"],
  retrying: ["verifying", "failed", "timed_out"],
  creating_pr: ["ready", "completed", "failed", "timed_out"],
  completed: [],
  failed: [],
  timed_out: [],
  cost_exceeded: [],
};

test("SESSION_STATES matches the transition table keys", () => {
  assert.deepEqual([...SESSION_STATES].sort(), Object.keys(ALLOWED_TRANSITIONS).sort());
});

test("isValidTransition allows only documented edges", () => {
  for (const from of SESSION_STATES) {
    const allowed = ALLOWED_TRANSITIONS[from];
    for (const to of SESSION_STATES) {
      const expected = allowed.includes(to);
      assert.equal(
        isValidTransition(from, to),
        expected,
        `expected ${from} → ${to} to be ${expected}`,
      );
    }
  }
});

test("terminal states have no outgoing transitions", () => {
  for (const state of SESSION_STATES) {
    assert.equal(isTerminalState(state), ALLOWED_TRANSITIONS[state].length === 0);
  }
});

test("clone completion can transition a session room to ready", () => {
  assert.equal(isValidTransition("cloning_repo", "ready"), true);
});

test("ready is a non-terminal resting state", () => {
  assert.equal(isTerminalState("ready"), false);
});

test("ready can start a general agent turn", () => {
  assert.equal(isValidTransition("ready", "executing"), true);
});

test("cost_exceeded is terminal and currently unreachable", () => {
  assert.equal(isTerminalState("cost_exceeded"), true);
  const inbound = SESSION_STATES.filter((from) => isValidTransition(from, "cost_exceeded"));
  assert.deepEqual(inbound, [], "cost_exceeded has no inbound transitions yet");
});
