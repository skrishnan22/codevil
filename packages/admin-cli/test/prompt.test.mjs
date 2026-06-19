import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PassThrough } from "node:stream";

import {
  createTerminalPrompt,
  parseNumericMultiSelect,
  PromptCancelledError,
} from "../dist/prompt.js";

test("parseNumericMultiSelect trims, dedupes, and preserves the first valid order", () => {
  assert.deepEqual(parseNumericMultiSelect(" 2, 1, 2,3 ", 3), [2, 1, 3]);
});

test("parseNumericMultiSelect rejects empty selections, out of range values, and non-numbers", () => {
  assert.throws(() => parseNumericMultiSelect("", 3), /Enter at least one number/);
  assert.throws(() => parseNumericMultiSelect("0", 3), /between 1 and 3/);
  assert.throws(() => parseNumericMultiSelect("4", 3), /between 1 and 3/);
  assert.throws(() => parseNumericMultiSelect("1,two", 3), /whole numbers/);
});

test("hidden input requires a TTY", async () => {
  const input = new PassThrough();
  input.isTTY = false;

  const output = new PassThrough();
  output.isTTY = false;

  const prompt = createTerminalPrompt({ input, output });

  await assert.rejects(
    () => prompt.hidden("API key: "),
    /requires an interactive terminal/i,
  );
});

class FakeTTYInput extends PassThrough {
  constructor({ isRaw = false, paused = false } = {}) {
    super();
    this.isTTY = true;
    this.isRaw = isRaw;
    this.rawModeCalls = [];
    this.resumeCalls = 0;
    this.pauseCalls = 0;
    this.pausedState = paused;
    this.setEncodingCalls = 0;
  }

  setRawMode(mode) {
    this.rawModeCalls.push(mode);
    this.isRaw = mode;
  }

  isPaused() {
    return this.pausedState;
  }

  pause() {
    this.pauseCalls += 1;
    this.pausedState = true;
    return this;
  }

  resume() {
    this.resumeCalls += 1;
    this.pausedState = false;
    return this;
  }

  setEncoding() {
    this.setEncodingCalls += 1;
    return this;
  }
}

class FakeTTYOutput extends PassThrough {
  constructor() {
    super();
    this.isTTY = true;
    this.buffer = "";
    this.setEncoding("utf8");
    this.on("data", (chunk) => {
      this.buffer += chunk;
    });
  }
}

function createHiddenPrompt({ isRaw = false, paused = false } = {}) {
  const input = new FakeTTYInput({ isRaw, paused });
  const output = new FakeTTYOutput();
  const signalTarget = new EventEmitter();
  const prompt = createTerminalPrompt({ input, output, signalTarget });
  return { prompt, input, output, signalTarget };
}

test("hidden input restores raw mode, pause state, and listeners on success without echoing typed characters", async () => {
  const { prompt, input, output, signalTarget } = createHiddenPrompt({ paused: true });
  const originalDataListeners = input.listenerCount("data");
  const originalErrorListeners = input.listenerCount("error");
  const originalSigintListeners = signalTarget.listenerCount("SIGINT");

  const pending = prompt.hidden("API key: ");
  input.emit("data", "s");
  input.emit("data", "e");
  input.emit("data", "c");
  input.emit("data", "r");
  input.emit("data", "e");
  input.emit("data", "t");
  input.emit("data", "\n");

  await assert.doesNotReject(() => pending);
  assert.equal(await pending, "secret");
  assert.deepEqual(input.rawModeCalls, [true, false]);
  assert.ok(input.resumeCalls >= 1);
  assert.ok(input.pauseCalls >= 1);
  assert.equal(input.isPaused(), true);
  assert.equal(input.setEncodingCalls, 0);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), originalDataListeners);
  assert.equal(input.listenerCount("error"), originalErrorListeners);
  assert.equal(signalTarget.listenerCount("SIGINT"), originalSigintListeners);
  assert.equal(output.buffer, "API key: \n");
});

test("hidden input restores original raw mode, pause state, and listeners after stream error", async () => {
  const { prompt, input, signalTarget } = createHiddenPrompt({ isRaw: true, paused: false });
  const originalDataListeners = input.listenerCount("data");
  const originalErrorListeners = input.listenerCount("error");
  const originalSigintListeners = signalTarget.listenerCount("SIGINT");

  const pending = prompt.hidden("API key: ");
  input.emit("error", new Error("stream broke"));

  await assert.rejects(() => pending, /stream broke/);
  assert.deepEqual(input.rawModeCalls, []);
  assert.ok(input.resumeCalls >= 1);
  assert.equal(input.pauseCalls, 0);
  assert.equal(input.isPaused(), false);
  assert.equal(input.setEncodingCalls, 0);
  assert.equal(input.isRaw, true);
  assert.equal(input.listenerCount("data"), originalDataListeners);
  assert.equal(input.listenerCount("error"), originalErrorListeners);
  assert.equal(signalTarget.listenerCount("SIGINT"), originalSigintListeners);
});

test("hidden input restores raw mode, pause state, and listeners after SIGINT cancellation", async () => {
  const { prompt, input, signalTarget } = createHiddenPrompt({ paused: true });
  const originalDataListeners = input.listenerCount("data");
  const originalErrorListeners = input.listenerCount("error");
  const originalSigintListeners = signalTarget.listenerCount("SIGINT");

  const pending = prompt.hidden("API key: ");
  signalTarget.emit("SIGINT");

  await assert.rejects(() => pending, (error) => {
    assert.equal(error instanceof PromptCancelledError, true);
    assert.match(error.message, /Prompt cancelled\./);
    return true;
  });
  assert.deepEqual(input.rawModeCalls, [true, false]);
  assert.ok(input.resumeCalls >= 1);
  assert.ok(input.pauseCalls >= 1);
  assert.equal(input.isPaused(), true);
  assert.equal(input.setEncodingCalls, 0);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), originalDataListeners);
  assert.equal(input.listenerCount("error"), originalErrorListeners);
  assert.equal(signalTarget.listenerCount("SIGINT"), originalSigintListeners);
});

test("hidden input treats ctrl-c data as a PromptCancelledError", async () => {
  const { prompt, input } = createHiddenPrompt();

  const pending = prompt.hidden("API key: ");
  input.emit("data", Buffer.from("secret\u0003ignored"));

  await assert.rejects(() => pending, (error) => {
    assert.equal(error instanceof PromptCancelledError, true);
    return true;
  });
});

test("hidden input completes from a pasted chunk at the first line terminator", async () => {
  const { prompt, input, output } = createHiddenPrompt();

  const pending = prompt.hidden("API key: ");
  input.emit("data", "secret\nignored");

  assert.equal(await pending, "secret");
  assert.equal(output.buffer, "API key: \n");
});

test("hidden input stops at CR in a pasted CRLF chunk", async () => {
  const { prompt, input } = createHiddenPrompt();

  const pending = prompt.hidden("API key: ");
  input.emit("data", "secret\r\nignored");

  assert.equal(await pending, "secret");
});

test("hidden input processes Buffer chunks character by character", async () => {
  const { prompt, input } = createHiddenPrompt();

  const pending = prompt.hidden("API key: ");
  input.emit("data", Buffer.from("secret\nignored"));

  assert.equal(await pending, "secret");
});

test("hidden input applies backspace and delete inside multi-character chunks", async () => {
  for (const eraseCharacter of ["\b", "\u007f"]) {
    const { prompt, input } = createHiddenPrompt();
    const pending = prompt.hidden("API key: ");
    input.emit("data", `secrx${eraseCharacter}et\n`);
    assert.equal(await pending, "secret");
  }
});
