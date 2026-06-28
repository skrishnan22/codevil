import assert from "node:assert/strict";
import test from "node:test";

import {
  AnnotationAnchorSchema,
  annotationReplyFromDbRow,
  parseAnnotationAnchorJson,
  parseSqliteRow,
  QuestionRowSchema,
} from "../dist/index.js";

test("parseSqliteRow: accepts a valid question row", () => {
  const row = parseSqliteRow(QuestionRowSchema, {
    run_id: "run_1",
    status: "open",
    answerable_by: "decider",
    assigned_to_id: null,
    assigned_to_name: null,
  }, "sqlite_question");

  assert.equal(row?.run_id, "run_1");
  assert.equal(row?.answerable_by, "decider");
});

test("parseSqliteRow: rejects invalid answerable_by", () => {
  const row = parseSqliteRow(QuestionRowSchema, {
    run_id: "run_1",
    status: "open",
    answerable_by: "nobody",
    assigned_to_id: null,
    assigned_to_name: null,
  }, "sqlite_question");

  assert.equal(row, null);
});

test("parseAnnotationAnchorJson: validates anchor_json column", () => {
  const anchor = {
    startMeta: { parentTagName: "p", parentIndex: 0, textOffset: 0 },
    endMeta: { parentTagName: "p", parentIndex: 0, textOffset: 4 },
    text: "plan",
    blockId: "block-1",
    sourceLine: 1,
  };
  AnnotationAnchorSchema.parse(anchor);

  const parsed = parseAnnotationAnchorJson(JSON.stringify(anchor));
  assert.equal(parsed?.text, "plan");
  assert.equal(parseAnnotationAnchorJson("{"), null);
});

test("annotationReplyFromDbRow: maps sqlite columns to reply shape", () => {
  const reply = annotationReplyFromDbRow({
    id: "reply_1",
    author_id: "usr_1",
    author_name: "Alice",
    body: "Looks good",
    created_at: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(reply.comment, "Looks good");
  assert.deepEqual(reply.author, { id: "usr_1", name: "Alice" });
});
