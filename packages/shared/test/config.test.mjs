import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigSchema,
  DEFAULT_CONFIG,
} from "../dist/config.js";

test("ConfigSchema validates a complete config file shape", () => {
  const parsed = ConfigSchema.parse({
    endpoint: "https://worker.example.com",
    api_key: "cv_test_key",
    defaults: DEFAULT_CONFIG,
  });
  assert.equal(parsed.defaults.provider, "opencode-go");
  assert.equal(parsed.defaults.plan_model, "deepseek-v4-flash");
  assert.equal(parsed.defaults.exec_model, "deepseek-v4-flash");
});

test("ConfigSchema rejects invalid endpoints", () => {
  const result = ConfigSchema.safeParse({
    endpoint: "not-a-url",
    api_key: "cv_test_key",
    defaults: DEFAULT_CONFIG,
  });
  assert.equal(result.success, false);
});
