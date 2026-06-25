import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  configureDefaultGitIdentity,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  ShellGitDriver,
  shallowCloneArgs,
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

test("shallowCloneArgs defaults clone operations to depth 1", () => {
  assert.deepEqual(shallowCloneArgs("https://github.com/example/app.git", "/workspace/repo"), [
    "clone",
    "--progress",
    "--depth",
    "1",
    "--no-tags",
    "https://github.com/example/app.git",
    "/workspace/repo",
  ]);
});

test("refresh preserves excluded dependency artifacts while cleaning other ignored files", async () => {
  const root = await mkdtemp(join(tmpdir(), "codevil-git-refresh-"));
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");

  try {
    await mkdir(source, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: source });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: source });
    await writeFile(join(source, ".gitignore"), "node_modules/\nignored.log\n");
    await writeFile(join(source, "README.md"), "initial\n");
    await mkdir(join(source, "apps", "web"), { recursive: true });
    await writeFile(join(source, "apps", "web", "package.json"), "{\"name\":\"web\"}\n");
    await execFileAsync("git", ["add", "."], { cwd: source });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: source });
    await execFileAsync("git", ["clone", "--bare", source, origin]);
    await execFileAsync("git", ["clone", origin, checkout]);

    await mkdir(join(checkout, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(checkout, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    await mkdir(join(checkout, "apps", "web", "node_modules", "react"), { recursive: true });
    await writeFile(join(checkout, "apps", "web", "node_modules", "react", "index.js"), "module.exports = {};\n");
    await writeFile(join(checkout, "ignored.log"), "remove me\n");

    const driver = new ShellGitDriver();
    await driver.refresh(origin, checkout, () => {}, undefined, [
      "node_modules/",
      "**/node_modules/",
    ]);

    await assert.doesNotReject(() =>
      execFileAsync("test", ["-f", join(checkout, "node_modules", "left-pad", "index.js")])
    );
    await assert.doesNotReject(() =>
      execFileAsync("test", ["-f", join(checkout, "apps", "web", "node_modules", "react", "index.js")])
    );
    await assert.rejects(() =>
      execFileAsync("test", ["-e", join(checkout, "ignored.log")])
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
