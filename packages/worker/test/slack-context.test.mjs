import assert from "node:assert/strict";
import test from "node:test";

import { formatSlackAgentRequest } from "../dist/integrations/slack/context.js";

test("formatSlackAgentRequest separates prior discussion from the tagged request", () => {
  const text = formatSlackAgentRequest({
    messages: [
      { ts: "10.01", user: "U2", text: "The deploy failed" },
      { ts: "10.03", user: "U1", text: "<@B1> investigate" },
    ],
    requesterId: "U1",
    explicitRequestTs: "10.03",
    botUserId: "B1",
  });

  assert.match(text, /Thread context:\nSlack U2: The deploy failed/);
  assert.match(text, /Explicit request:\nSlack U1: investigate/);
});

test("formatSlackAgentRequest uses only the continuation slice and excludes bots", () => {
  const text = formatSlackAgentRequest({
    messages: [
      { ts: "10.01", user: "U1", text: "old context" },
      { ts: "10.03", user: "U1", text: "<@B1> old request" },
      { ts: "10.05", bot_id: "BOT", text: "Codevil started working" },
      { ts: "10.04", user: "U2", text: "check auth too" },
      { ts: "10.06", user: "U1", text: "<@B1> follow up" },
      { ts: "10.07", user: "U3", text: "future message" },
    ],
    requesterId: "U1",
    explicitRequestTs: "10.06",
    lastHandledMessageId: "10.03",
    botUserId: "B1",
  });

  assert.doesNotMatch(text, /old context|old request|Codevil started|future message/);
  assert.match(text, /Slack U2: check auth too/);
  assert.match(text, /Explicit request:\nSlack U1: follow up/);
});

test("formatSlackAgentRequest stays within the Agent Request size limit", () => {
  const text = formatSlackAgentRequest({
    messages: [
      { ts: "10.01", user: "U2", text: "x".repeat(25_000) },
      { ts: "10.03", user: "U1", text: `<@B1> ${"y".repeat(2_000)}` },
    ],
    requesterId: "U1",
    explicitRequestTs: "10.03",
    botUserId: "B1",
  });

  assert.ok(text.length <= 20_000);
  assert.match(text, /Explicit request:\nSlack U1: y+/);
});
