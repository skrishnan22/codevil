import { test } from "node:test";
import assert from "node:assert/strict";

import { toConsolidationAnnotations } from "../dist/annotations.js";

// Minimal valid AnnotationAnchor fixture
const validAnchor = {
  startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 0 },
  endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 10 },
  text: "Use Redis",
  blockId: "block-001",
  sourceLine: 3,
};

// Minimal valid AnnotationThread fixture (no replies)
const threadNoReplies = {
  id: "ann_1",
  run_id: "run_1",
  round: 0,
  anchor: validAnchor,
  author: { id: "usr_1", name: "Alice" },
  comment: "Use D1-backed storage instead.",
  status: "open",
  created_at: "2026-06-12T00:00:00.000Z",
  replies: [],
};

// Thread with one reply
const threadWithReply = {
  id: "ann_2",
  run_id: "run_1",
  round: 0,
  anchor: {
    ...validAnchor,
    text: "Cloudflare Workers",
    sourceLine: 7,
    blockId: "block-002",
  },
  author: { id: "usr_2", name: "Bob" },
  comment: "Consider edge caching here.",
  status: "open",
  created_at: "2026-06-12T00:01:00.000Z",
  replies: [
    {
      id: "rep_1",
      author: { id: "usr_1", name: "Alice" },
      comment: "Good point, will update.",
      created_at: "2026-06-12T00:02:00.000Z",
    },
  ],
};

test("toConsolidationAnnotations: thread with no replies maps correctly", () => {
  const result = toConsolidationAnnotations([threadNoReplies]);

  assert.equal(result.length, 1);
  const ann = result[0];
  assert.equal(ann.id, "ann_1");
  assert.equal(ann.anchoredQuote, "Use Redis");
  assert.equal(ann.sourceLine, 3);
  assert.equal(ann.authorName, "Alice");
  assert.equal(ann.comment, "Use D1-backed storage instead.");
  assert.deepEqual(ann.replies, []);
});

test("toConsolidationAnnotations: thread with reply maps correctly", () => {
  const result = toConsolidationAnnotations([threadWithReply]);

  assert.equal(result.length, 1);
  const ann = result[0];
  assert.equal(ann.id, "ann_2");
  assert.equal(ann.anchoredQuote, "Cloudflare Workers");
  assert.equal(ann.sourceLine, 7);
  assert.equal(ann.authorName, "Bob");
  assert.equal(ann.comment, "Consider edge caching here.");
  assert.equal(ann.replies.length, 1);
  assert.equal(ann.replies[0].authorName, "Alice");
  assert.equal(ann.replies[0].body, "Good point, will update.");
});

test("toConsolidationAnnotations: anchoredQuote comes from anchor.text", () => {
  const thread = { ...threadNoReplies, anchor: { ...validAnchor, text: "Specific highlighted text" } };
  const [ann] = toConsolidationAnnotations([thread]);
  assert.equal(ann.anchoredQuote, "Specific highlighted text");
});

test("toConsolidationAnnotations: sourceLine comes from anchor.sourceLine", () => {
  const thread = { ...threadNoReplies, anchor: { ...validAnchor, sourceLine: 42 } };
  const [ann] = toConsolidationAnnotations([thread]);
  assert.equal(ann.sourceLine, 42);
});

test("toConsolidationAnnotations: reply body comes from reply.comment", () => {
  const reply = { id: "rep_x", author: { id: "usr_3", name: "Carol" }, comment: "Needs rework.", created_at: "2026-06-12T00:03:00.000Z" };
  const thread = { ...threadNoReplies, replies: [reply] };
  const [ann] = toConsolidationAnnotations([thread]);
  assert.equal(ann.replies[0].body, "Needs rework.");
  assert.equal(ann.replies[0].authorName, "Carol");
});

test("toConsolidationAnnotations: handles multiple threads", () => {
  const result = toConsolidationAnnotations([threadNoReplies, threadWithReply]);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "ann_1");
  assert.equal(result[1].id, "ann_2");
});

test("toConsolidationAnnotations: returns empty array for empty input", () => {
  const result = toConsolidationAnnotations([]);
  assert.deepEqual(result, []);
});

test("toConsolidationAnnotations: thread with undefined replies treated as no replies", () => {
  const { replies: _dropped, ...threadWithoutReplies } = threadNoReplies;
  const result = toConsolidationAnnotations([{ ...threadWithoutReplies }]);
  assert.deepEqual(result[0].replies, []);
});
