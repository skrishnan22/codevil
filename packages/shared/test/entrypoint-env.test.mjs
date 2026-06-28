import assert from "node:assert/strict";
import test from "node:test";

import {
  EntrypointEnvSchema,
  parseEntrypointEnv,
  pickEntrypointEnvFields,
} from "../dist/index.js";

test("parseEntrypointEnv: accepts known sandbox keys and ignores extras", () => {
  const env = parseEntrypointEnv({
    CODEVIL_DO_WS_URL: "wss://example.com/sessions/ses_1/sandbox",
    PATH: "/usr/bin",
    RANDOM: "ignored",
  });

  assert.equal(env.CODEVIL_DO_WS_URL, "wss://example.com/sessions/ses_1/sandbox");
  assert.equal(env.PATH, undefined);
});

test("parseEntrypointEnv: rejects empty CODEVIL_DO_WS_URL", () => {
  assert.throws(
    () => parseEntrypointEnv({ CODEVIL_DO_WS_URL: "" }),
    /Invalid sandbox env/,
  );
});

test("pickEntrypointEnvFields: only keeps entrypoint keys", () => {
  const picked = pickEntrypointEnvFields({
    CODEVIL_PROVIDER: "opencode-go",
    HOME: "/root",
  });

  assert.deepEqual(picked, { CODEVIL_PROVIDER: "opencode-go" });
  assert.equal(EntrypointEnvSchema.safeParse(picked).success, true);
});
