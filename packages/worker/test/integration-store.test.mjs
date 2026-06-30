import assert from "node:assert/strict";
import test from "node:test";

import {
  clearChannelDefaultRepoUpdate,
  dedupeEventInsert,
  externalActorRowId,
  externalParticipantId,
  externalSessionLinkBySessionSelect,
  externalSessionLinkId,
  externalSessionLinkInsert,
  externalSessionLinkSelect,
  integrationByProviderWorkspaceSelect,
  integrationChannelRowId,
  integrationId,
  upsertChannelDefaultRepo,
  upsertExternalActor,
  upsertIntegration,
} from "../dist/integrations/store.js";

test("integration store derives deterministic provider-neutral ids", () => {
  const integrationIdValue = integrationId("slack", "T123");

  assert.equal(integrationIdValue, "int_slack_T123");
  assert.equal(externalActorRowId(integrationIdValue, "U123"), "iea_int_slack_T123_U123");
  assert.equal(integrationChannelRowId(integrationIdValue, "C123"), "ich_int_slack_T123_C123");
  assert.equal(externalSessionLinkId(integrationIdValue, "C123", "171951.0001"), "esl_int_slack_T123_C123_171951.0001");
  assert.equal(externalParticipantId("slack", "U123"), "external:slack:U123");
});

test("upsertIntegration uses provider/workspace conflict and preserves deterministic bindings", () => {
  const statement = upsertIntegration({
    id: "int_slack_T123",
    provider: "slack",
    external_workspace_id: "T123",
    external_workspace_name: "Acme",
    bot_external_actor_id: "U999",
    config_json: "{\"mode\":\"manifest\"}",
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:01.000Z",
  });

  assert.match(statement.sql, /^INSERT INTO integrations/i);
  assert.match(statement.sql, /ON CONFLICT\(provider, external_workspace_id\) DO UPDATE/i);
  assert.deepEqual(statement.bindings, [
    "int_slack_T123",
    "slack",
    "T123",
    "Acme",
    "U999",
    "{\"mode\":\"manifest\"}",
    "2026-06-28T00:00:00.000Z",
    "2026-06-28T00:00:01.000Z",
  ]);
});

test("channel and external actor upserts target their natural external ids", () => {
  const actor = upsertExternalActor({
    id: "iea_int_slack_T123_U123",
    integration_id: "int_slack_T123",
    external_actor_id: "U123",
    display_name: "Alice",
    email: null,
    linked_auth_user_id: null,
    metadata_json: "{}",
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:01.000Z",
  });
  const channel = upsertChannelDefaultRepo({
    id: "ich_int_slack_T123_C123",
    integration_id: "int_slack_T123",
    external_channel_id: "C123",
    display_name: "eng",
    default_repo_url: "https://github.com/acme/app",
    metadata_json: "{}",
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:01.000Z",
  });

  assert.match(actor.sql, /ON CONFLICT\(integration_id, external_actor_id\) DO UPDATE/i);
  assert.match(channel.sql, /ON CONFLICT\(integration_id, external_channel_id\) DO UPDATE/i);
  assert.equal(channel.bindings[4], "https://github.com/acme/app");
});

test("external session link statements bind conversation lookup values in order", () => {
  const insert = externalSessionLinkInsert({
    id: "esl_int_slack_T123_C123_171951.0001",
    integration_id: "int_slack_T123",
    external_channel_id: "C123",
    external_conversation_id: "171951.0001",
    session_id: "ses_123",
    last_handled_message_id: "171951.0002",
    created_by_external_actor_id: "U123",
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:01.000Z",
  });
  const select = externalSessionLinkSelect("int_slack_T123", "C123", "171951.0001");

  assert.match(insert.sql, /^INSERT INTO external_session_links/i);
  assert.deepEqual(select.bindings, ["int_slack_T123", "C123", "171951.0001"]);
});

test("dedupe insert ignores duplicate external events", () => {
  const statement = dedupeEventInsert("Ev123", "int_slack_T123", "171951.0001", "2026-06-28T00:00:00.000Z");

  assert.match(statement.sql, /^INSERT OR IGNORE INTO external_message_dedupe/i);
  assert.deepEqual(statement.bindings, [
    "emd_int_slack_T123_Ev123",
    "int_slack_T123",
    "Ev123",
    "171951.0001",
    "2026-06-28T00:00:00.000Z",
  ]);
});

test("dedupe insert scopes duplicate detection by integration", () => {
  const first = dedupeEventInsert("Ev123", "int_slack_T123", null, "2026-06-28T00:00:00.000Z");
  const second = dedupeEventInsert("Ev123", "int_slack_T456", null, "2026-06-28T00:00:00.000Z");

  assert.match(first.sql, /integration_id,\s*external_event_id/s);
  assert.equal(first.bindings[0], "emd_int_slack_T123_Ev123");
  assert.equal(second.bindings[0], "emd_int_slack_T456_Ev123");
});

test("externalSessionLinkBySessionSelect looks up all external links for a session", () => {
  const statement = externalSessionLinkBySessionSelect("ses_123");

  assert.match(statement.sql, /FROM external_session_links/i);
  assert.match(statement.sql, /WHERE session_id = \?/i);
  assert.deepEqual(statement.bindings, ["ses_123"]);
});

test("channel default repo can be selected and cleared", () => {
  const select = integrationByProviderWorkspaceSelect("slack", "T123");
  const clear = clearChannelDefaultRepoUpdate("int_slack_T123", "C123", "2026-06-28T00:00:00.000Z");

  assert.deepEqual(select.bindings, ["slack", "T123"]);
  assert.match(clear.sql, /SET default_repo_url = NULL/i);
  assert.deepEqual(clear.bindings, ["2026-06-28T00:00:00.000Z", "int_slack_T123", "C123"]);
});
