import assert from "node:assert/strict";
import test from "node:test";

import {
  EntrypointEnvSchema,
  parseEntrypointEnv,
  parseProviderPublicConfig,
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

test("parseProviderPublicConfig accepts only the declared Cloudflare identifiers", () => {
  assert.deepEqual(
    parseProviderPublicConfig(JSON.stringify({
      CLOUDFLARE_ACCOUNT_ID: "account_123",
      CLOUDFLARE_GATEWAY_ID: "gateway_456",
    })),
    {
      CLOUDFLARE_ACCOUNT_ID: "account_123",
      CLOUDFLARE_GATEWAY_ID: "gateway_456",
    },
  );
});

test("parseProviderPublicConfig fails closed on malformed or undeclared sandbox configuration", () => {
  assert.throws(() => parseProviderPublicConfig("{"), /Invalid provider configuration JSON/);
  assert.throws(
    () => parseProviderPublicConfig(JSON.stringify({
      CLOUDFLARE_ACCOUNT_ID: "account_123",
      NODE_OPTIONS: "--require arbitrary-module",
    })),
    /Invalid provider configuration/,
  );
});
