import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAndUnlinkSecret } from "../dist/secrets.js";

test("readAndUnlinkSecret reads file content and deletes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codevil-secrets-"));
  const path = join(dir, "llm_key");
  try {
    await writeFile(path, "  sk-test-key  \n", "utf8");
    const value = await readAndUnlinkSecret(path);
    assert.equal(value, "sk-test-key");
    assert.equal(await readAndUnlinkSecret(path), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readAndUnlinkSecret returns undefined when file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codevil-secrets-missing-"));
  const path = join(dir, "missing");
  try {
    assert.equal(await readAndUnlinkSecret(path), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readAndUnlinkSecret returns undefined for empty file content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codevil-secrets-empty-"));
  const path = join(dir, "llm_key");
  try {
    await writeFile(path, "   \n", "utf8");
    assert.equal(await readAndUnlinkSecret(path), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
