import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  configureDefaultGitIdentity,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
} from "../dist/git-driver.js";

const execFileAsync = promisify(execFile);

test("configureDefaultGitIdentity sets the sandbox git author", async () => {
  const home = await mkdtemp(join(tmpdir(), "codevil-git-home-"));
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = home;

    await configureDefaultGitIdentity();

    const [{ stdout: name }, { stdout: email }] = await Promise.all([
      execFileAsync("git", ["config", "--global", "--get", "user.name"]),
      execFileAsync("git", ["config", "--global", "--get", "user.email"]),
    ]);

    assert.equal(name.trim(), DEFAULT_GIT_AUTHOR_NAME);
    assert.equal(email.trim(), DEFAULT_GIT_AUTHOR_EMAIL);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
