import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultTracerSink, setTracerSink } from "@codevil/shared";
import {
  createSandboxWsTokenSource,
  readTokenFile,
  watchSandboxWsToken,
  withSandboxWebSocketToken,
} from "../dist/entrypoint.js";

const BASE = "wss://w/sessions/ses_1/sandbox/ws?sandbox_ws_token=old";
const tokenOf = (url) => new URL(url).searchParams.get("sandbox_ws_token");

test("token source follows file/in-memory precedence across reconnects", () => {
  let fileContent;
  const source = createSandboxWsTokenSource(() => fileContent);

  // (a) file absent -> unchanged
  let wsUrl = source.applyTo(BASE);
  assert.equal(wsUrl, BASE);

  // (b) first non-empty file value is adopted
  fileContent = "file-1\n";
  wsUrl = source.applyTo(wsUrl);
  assert.equal(tokenOf(wsUrl), "file-1");

  // (c) newer in-memory token (proxy_capabilities) wins over an unchanged file
  wsUrl = withSandboxWebSocketToken(wsUrl, "memory-2");
  wsUrl = source.applyTo(wsUrl);
  assert.equal(tokenOf(wsUrl), "memory-2");

  // (d) a changed file value is adopted again
  fileContent = "file-3\n";
  wsUrl = source.applyTo(wsUrl);
  assert.equal(tokenOf(wsUrl), "file-3");

  // (e) whitespace-only file is ignored
  fileContent = "  \n";
  assert.equal(source.applyTo(wsUrl), wsUrl);
});

test("readTokenFile reads a file and returns undefined for a missing path", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-token-"));
  const path = join(dir, "ws-token");
  writeFileSync(path, "fresh\n");
  assert.equal(readTokenFile(path)?.trim(), "fresh");
  assert.equal(readTokenFile(join(dir, "missing")), undefined);
});

function captureLogs(run) {
  const lines = [];
  setTracerSink((line) => lines.push(line));
  try {
    run();
  } finally {
    setTracerSink(defaultTracerSink);
  }
  return lines;
}

test("readTokenFile stays quiet for a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-token-"));
  const lines = captureLogs(() => {
    assert.equal(readTokenFile(join(dir, "missing")), undefined);
  });
  assert.deepEqual(lines, []);
});

test("readTokenFile logs a WARN with the error code, never the content, when the read fails for another reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-token-"));
  const secretPath = join(dir, "secret-token");
  writeFileSync(secretPath, "very-secret-token\n");
  chmodSync(secretPath, 0o000);
  const unreadable = (() => {
    try { writeFileSync(secretPath, "x", { flag: "r" }); } catch { /* expected */ }
    return process.getuid?.() !== 0;
  })();
  // A directory is unreadable as a file for every user, root included (EISDIR).
  const directoryPath = join(dir, "is-a-dir");
  mkdirSync(directoryPath);

  const cases = [[directoryPath, "EISDIR"]];
  if (unreadable) cases.push([secretPath, "EACCES"]);
  for (const [path, code] of cases) {
    const lines = captureLogs(() => {
      assert.equal(readTokenFile(path), undefined);
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].severity, "WARN");
    assert.equal(lines[0].operation, "sandbox.ws_token_file.read_failed");
    assert.match(JSON.stringify(lines[0]), new RegExp(code));
    assert.doesNotMatch(JSON.stringify(lines[0]), /very-secret-token/);
  }
  chmodSync(secretPath, 0o600);
});

function watcherHarness(initialUrl = BASE) {
  let fileContent;
  let wsUrl = initialUrl;
  const adopted = [];
  const timers = [];
  const cleared = [];
  const unrefs = [];
  const stop = watchSandboxWsToken({
    tokenSource: createSandboxWsTokenSource(() => fileContent),
    getUrl: () => wsUrl,
    setUrl: (url) => { wsUrl = url; },
    onTokenAdopted: () => adopted.push(wsUrl),
    setInterval: (callback, delay) => {
      const timer = { callback, delay, unref: () => unrefs.push(true) };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => cleared.push(timer),
  });
  return {
    adopted, timers, cleared, unrefs, stop,
    tick: () => timers[0].callback(),
    write: (value) => { fileContent = value; },
    get url() { return wsUrl; },
  };
}

test("token watcher polls every 2s on an unref'd timer and adopts only changed tokens", () => {
  const h = watcherHarness();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delay, 2_000);
  assert.equal(h.unrefs.length, 1);

  h.tick(); // no file
  assert.deepEqual(h.adopted, []);

  h.write("fresh-1\n");
  h.tick();
  assert.equal(tokenOf(h.url), "fresh-1");
  assert.equal(h.adopted.length, 1);

  h.tick(); // unchanged file: no second adoption
  h.tick();
  assert.equal(h.adopted.length, 1);

  h.write("fresh-2\n");
  h.tick();
  assert.equal(tokenOf(h.url), "fresh-2");
  assert.equal(h.adopted.length, 2);

  h.stop();
  assert.equal(h.cleared.length, 1);
});

test("token watcher does not reconnect when the file token is the one already in the URL", () => {
  const h = watcherHarness(withSandboxWebSocketToken(BASE, "same"));
  h.write("same\n");
  h.tick();
  h.tick();
  assert.deepEqual(h.adopted, []);
});
