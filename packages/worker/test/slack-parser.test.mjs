import assert from "node:assert/strict";
import test from "node:test";

import {
  SlackEventCallbackSchema,
  SlackUrlVerificationSchema,
  containsBotMention,
  parseCodevilSlashCommand,
  slackThreadRootTs,
  stripBotMention,
} from "../dist/integrations/slack/parser.js";

test("Slack parser schemas accept URL verification and event callbacks", () => {
  assert.deepEqual(SlackUrlVerificationSchema.parse({ type: "url_verification", challenge: "abc" }), {
    type: "url_verification",
    challenge: "abc",
  });

  const parsed = SlackEventCallbackSchema.parse({
    type: "event_callback",
    event_id: "Ev123",
    team_id: "T123",
    event: {
      type: "app_mention",
      text: "<@U999> check this",
      user: "U123",
      channel: "C123",
      ts: "171951.0001",
      extra_provider_field: true,
    },
  });

  assert.equal(parsed.event.type, "app_mention");
  assert.equal(parsed.event.extra_provider_field, true);
});

test("stripBotMention removes Slack bot mentions and normalizes whitespace", () => {
  assert.equal(stripBotMention("<@U999> please inspect this", "U999"), "please inspect this");
  assert.equal(stripBotMention("please <@U999> inspect this", "U999"), "please inspect this");
  assert.equal(stripBotMention("please inspect this", "U999"), "please inspect this");
  assert.equal(stripBotMention("<@U999> please", undefined), "<@U999> please");
});

test("containsBotMention detects exact Slack mention tokens", () => {
  assert.equal(containsBotMention("<@U999> hello", "U999"), true);
  assert.equal(containsBotMention("hello <@U999>", "U999"), true);
  assert.equal(containsBotMention("<@U99> hello", "U999"), false);
  assert.equal(containsBotMention(undefined, "U999"), false);
  assert.equal(containsBotMention("<@U999> hello", undefined), false);
});

test("slackThreadRootTs prefers thread_ts and falls back to the message ts", () => {
  assert.equal(slackThreadRootTs({ ts: "171951.0002", thread_ts: "171951.0001" }), "171951.0001");
  assert.equal(slackThreadRootTs({ ts: "171951.0002" }), "171951.0002");
});

test("parseCodevilSlashCommand parses supported commands", () => {
  assert.deepEqual(parseCodevilSlashCommand("set-repo https://github.com/acme/app"), {
    type: "set_repo",
    repoUrl: "https://github.com/acme/app",
  });
  assert.deepEqual(parseCodevilSlashCommand("repo"), { type: "repo" });
  assert.deepEqual(parseCodevilSlashCommand("clear-repo"), { type: "clear_repo" });
  assert.deepEqual(parseCodevilSlashCommand(""), { type: "help" });
  assert.deepEqual(parseCodevilSlashCommand("unknown"), { type: "help" });
});
