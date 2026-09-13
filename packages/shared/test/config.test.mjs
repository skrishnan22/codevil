import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../dist/index.js";

test("DEFAULT_CONFIG sets a 20-minute default max sandbox time", () => {
  assert.equal(DEFAULT_CONFIG.max_time, "20m");
});

test("DEFAULT_CONFIG includes plan model, exec model, and provider defaults", () => {
  assert.equal(DEFAULT_CONFIG.plan_model, "deepseek-v4-flash");
  assert.equal(DEFAULT_CONFIG.exec_model, "deepseek-v4-flash");
  assert.equal(DEFAULT_CONFIG.provider, "opencode-go");
});