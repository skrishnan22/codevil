import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ReconnectingWebSocketClient } from "../dist/socket-client.js";

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent = [];
  pingCount = 0;
  terminated = false;

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  send(value) {
    this.sent.push(value);
  }

  ping() {
    this.pingCount++;
  }

  pong() {
    this.emit("pong");
  }

  terminate() {
    this.terminated = true;
  }

  disconnect(code = 1006, reason = "lost") {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  close() {
    this.readyState = 3;
  }
}

class FakeScheduler {
  nextId = 1;
  timers = new Map();

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id;
  };

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  delays() {
    return [...this.timers.values()].map((timer) => timer.delay);
  }

  run(delay) {
    const entry = [...this.timers.entries()].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `missing ${delay}ms timer`);
    const [id, timer] = entry;
    this.timers.delete(id);
    timer.callback();
  }
}

function createHarness(overrides = {}) {
  const sockets = [];
  const scheduler = new FakeScheduler();
  const events = [];
  const client = new ReconnectingWebSocketClient({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    heartbeatIntervalMs: 30_000,
    pongTimeoutMs: 10_000,
    reconnectBaseDelayMs: 1_000,
    reconnectMaxDelayMs: 30_000,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    onOpen: () => events.push("open"),
    onClose: (code, reason) => events.push(`close:${code}:${reason}`),
    onMessage: () => {},
    onError: () => {},
    ...overrides,
  });
  return { client, sockets, scheduler, events };
}

test("sends heartbeat pings and accepts pong responses", () => {
  const { client, sockets, scheduler } = createHarness();

  client.start();
  sockets[0].open();
  assert.deepEqual(scheduler.delays(), [30_000]);

  scheduler.run(30_000);
  assert.equal(sockets[0].pingCount, 1);
  assert.deepEqual(scheduler.delays(), [10_000]);

  sockets[0].pong();
  assert.deepEqual(scheduler.delays(), [30_000]);
});

test("terminates a socket that misses its pong deadline", () => {
  const { client, sockets, scheduler } = createHarness();

  client.start();
  sockets[0].open();
  scheduler.run(30_000);
  scheduler.run(10_000);

  assert.equal(sockets[0].terminated, true);
});

test("reconnects with bounded exponential backoff", () => {
  const { client, sockets, scheduler } = createHarness();

  client.start();
  sockets[0].disconnect();
  assert.deepEqual(scheduler.delays(), [1_000]);

  scheduler.run(1_000);
  assert.equal(sockets.length, 2);
  sockets[1].disconnect();
  assert.deepEqual(scheduler.delays(), [2_000]);
});

test("buffers outbound messages and flushes them after reconnect", () => {
  const { client, sockets, scheduler } = createHarness();

  client.start();
  client.send("queued");
  sockets[0].open();
  assert.deepEqual(sockets[0].sent, ["queued"]);

  sockets[0].disconnect();
  client.send("during reconnect");
  scheduler.run(1_000);
  sockets[1].open();

  assert.deepEqual(sockets[1].sent, ["during reconnect"]);
});
