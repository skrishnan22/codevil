import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMigrationCheck,
  runMigrationCheck,
} from "../scripts/check-d1-migrations.mjs";

function createRecorder() {
  const errors = [];
  const summaries = [];

  return {
    errors,
    summaries,
    writeError(message) {
      errors.push(message);
    },
    writeSummary(message) {
      summaries.push(message);
    },
  };
}

test("allows deployment when the remote database has no pending migrations", () => {
  const recorder = createRecorder();

  const exitCode = evaluateMigrationCheck(
    { status: 0, stdout: "✅ No migrations to apply!\n", stderr: "" },
    recorder,
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(recorder.errors, []);
  assert.deepEqual(recorder.summaries, []);
});

test("blocks deployment and reports pending migrations", () => {
  const recorder = createRecorder();
  const output = [
    "Migrations to be applied:",
    "┌──────────────────────────────────────┐",
    "│ Name                                 │",
    "├──────────────────────────────────────┤",
    "│ 0007_add_deployment_state.sql        │",
    "└──────────────────────────────────────┘",
  ].join("\n");

  const exitCode = evaluateMigrationCheck(
    { status: 0, stdout: output, stderr: "" },
    recorder,
  );

  assert.equal(exitCode, 1);
  assert.match(recorder.errors[0], /pending D1 migrations/i);
  assert.match(recorder.summaries[0], /0007_add_deployment_state\.sql/);
  assert.match(
    recorder.summaries[0],
    /pnpm --filter @codevil\/worker exec wrangler d1 migrations apply DB --remote/,
  );
});

test("blocks deployment when Wrangler fails", () => {
  const recorder = createRecorder();

  const exitCode = evaluateMigrationCheck(
    { status: 2, stdout: "", stderr: "Authentication error" },
    recorder,
  );

  assert.equal(exitCode, 1);
  assert.match(recorder.errors[0], /could not check D1 migrations/i);
  assert.match(recorder.summaries[0], /Authentication error/);
});

test("blocks deployment when Wrangler output is unrecognized", () => {
  const recorder = createRecorder();

  const exitCode = evaluateMigrationCheck(
    { status: 0, stdout: "Unexpected response", stderr: "" },
    recorder,
  );

  assert.equal(exitCode, 1);
  assert.match(recorder.errors[0], /could not determine D1 migration state/i);
  assert.match(recorder.summaries[0], /Unexpected response/);
});

test("queries the remote DB binding through the package Wrangler binary", () => {
  const recorder = createRecorder();
  const calls = [];
  const stdout = [];
  const stderr = [];

  const exitCode = runMigrationCheck({
    env: { CLOUDFLARE_API_TOKEN: "test-token" },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "✅ No migrations to apply!\n", stderr: "" };
    },
    writers: recorder,
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls[0].command, "pnpm");
  assert.deepEqual(calls[0].args, [
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "list",
    "DB",
    "--remote",
  ]);
  assert.match(calls[0].options.cwd, /packages\/worker\/?$/);
  assert.equal(calls[0].options.env.CLOUDFLARE_API_TOKEN, "test-token");
  assert.equal(calls[0].options.timeout, 60_000);
  assert.deepEqual(stdout, ["✅ No migrations to apply!\n"]);
  assert.deepEqual(stderr, []);
});

test("reports a clear failure when the Wrangler migration check times out", () => {
  const recorder = createRecorder();
  const timeoutError = Object.assign(new Error("spawnSync pnpm ETIMEDOUT"), {
    code: "ETIMEDOUT",
  });

  const exitCode = runMigrationCheck({
    spawn() {
      return { status: null, stdout: "", stderr: "", error: timeoutError };
    },
    writers: recorder,
    stdout: { write() {} },
    stderr: { write() {} },
  });

  assert.equal(exitCode, 1);
  assert.match(recorder.errors[0], /timed out after 60 seconds/i);
  assert.match(recorder.summaries[0], /timed out after 60 seconds/i);
});
