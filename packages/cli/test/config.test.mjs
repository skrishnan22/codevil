import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createConfig,
  getConfigPath,
  readConfig,
  writeConfig,
} from "../dist/config.js";

test("writes and reads config from ~/.codevil/config", async () => {
  const home = await mkdtemp(join(tmpdir(), "codevil-home-"));

  try {
    const config = createConfig("https://codevil.example.com/", "secret", {
      provider: "anthropic",
    });
    await writeConfig(config, { home });

    assert.equal(getConfigPath({ home }), join(home, ".codevil", "config"));
    assert.deepEqual(await readConfig({ home }), {
      ...config,
      endpoint: "https://codevil.example.com",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("defaults new configs to OpenCode Go Kimi", () => {
  const config = createConfig("https://codevil.example.com/", "secret");

  assert.equal(config.defaults.provider, "opencode-go");
  assert.equal(config.defaults.plan_model, "kimi-k2.6");
  assert.equal(config.defaults.exec_model, "kimi-k2.6");
});

test("persists configured default models", () => {
  const config = createConfig("https://codevil.example.com/", "secret", {
    provider: "kimi-coding",
    planModel: "kimi-for-coding",
    execModel: "kimi-k2-thinking",
  });

  assert.equal(config.defaults.provider, "kimi-coding");
  assert.equal(config.defaults.plan_model, "kimi-for-coding");
  assert.equal(config.defaults.exec_model, "kimi-k2-thinking");
});

test("reports missing config with init guidance", async () => {
  const home = await mkdtemp(join(tmpdir(), "codevil-home-"));

  try {
    await mkdir(join(home, ".codevil"));
    await assert.rejects(
      () => readConfig({ home }),
      /No Codevil config found. Run `codevil init` first./,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
