import assert from "node:assert/strict";
import test from "node:test";

import {
  isTerminalState,
  isValidTransition,
} from "../dist/index.js";

test("clone completion can transition a session room to ready", () => {
  assert.equal(isValidTransition("cloning_repo", "ready"), true);
});

test("ready is a non-terminal resting state", () => {
  assert.equal(isTerminalState("ready"), false);
});

test("ready can start a general agent turn", () => {
  assert.equal(isValidTransition("ready", "executing"), true);
});
