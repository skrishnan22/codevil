import assert from "node:assert/strict";
import test from "node:test";

import { buildSlackManifest } from "../dist/integrations/slack/manifest.js";

test("buildSlackManifest includes Codevil Slack routes and bot identity", () => {
  const manifest = buildSlackManifest("https://worker.example.com/");

  assert.match(manifest, /display_name: Codevil/);
  assert.match(manifest, /command: \/codevil/);
  assert.match(manifest, /url: https:\/\/worker\.example\.com\/slack\/commands/);
  assert.match(manifest, /request_url: https:\/\/worker\.example\.com\/slack\/events/);
});

test("buildSlackManifest includes required bot scopes", () => {
  const manifest = buildSlackManifest("https://worker.example.com");

  for (const scope of [
    "app_mentions:read",
    "commands",
    "chat:write",
    "channels:history",
    "channels:read",
    "groups:history",
    "groups:read",
    "users:read",
  ]) {
    assert.match(manifest, new RegExp(`- ${scope.replace(":", "\\:")}`));
  }
});

test("buildSlackManifest disables socket mode and interactivity", () => {
  const manifest = buildSlackManifest("https://worker.example.com");

  assert.doesNotMatch(manifest, /socket_mode_enabled:\s*true/);
  assert.match(manifest, /socket_mode_enabled: false/);
  assert.match(manifest, /is_enabled: false/);
});

test("buildSlackManifest subscribes only to events handled by the adapter", () => {
  const manifest = buildSlackManifest("https://worker.example.com");

  assert.match(manifest, /- app_mention/);
  assert.doesNotMatch(manifest, /message\.channels/);
  assert.doesNotMatch(manifest, /message\.groups/);
});
