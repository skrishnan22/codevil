import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  configureDefaultGitIdentity,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  runGitCommand,
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
    await driver.refresh(origin, checkout, () => {}, [
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

test("refresh sends the proxy capability for every remote request without persisting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "codevil-git-proxy-refresh-"));
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  const commandLog = join(root, "git-commands.jsonl");
  const originalPath = process.env.PATH;
  const capability = "git-capability-that-must-not-persist";

  try {
    await mkdir(join(checkout, ".git"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(checkout, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    await writeFile(join(bin, "git"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.CODEVIL_GIT_COMMAND_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
    await chmod(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.CODEVIL_GIT_COMMAND_LOG = commandLog;

    const driver = new ShellGitDriver({
      proxyBase: "https://worker.example",
      proxySessionId: "session-1",
      gitProxyCapability: capability,
    });
    await driver.refresh("https://github.com/example/app.git", checkout, () => {});

    const commands = (await readFile(commandLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const header = `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${capability}`).toString("base64")}`;
    const fetch = commands.find((args) => args.includes("fetch"));
    const setHead = commands.find((args) => args.includes("set-head"));
    const setUrl = commands.find((args) => args.includes("set-url"));

    assert.ok(fetch);
    assert.ok(setHead);
    assert.ok(setUrl);
    assert.ok(fetch.includes(header));
    assert.ok(setHead.includes(header));
    assert.ok(!setUrl.includes(header));
    assert.ok(!commands.flat().some((argument) => argument.includes(capability) && argument !== header));
    assert.doesNotMatch(await readFile(join(checkout, ".git", "config"), "utf8"), new RegExp(capability));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    delete process.env.CODEVIL_GIT_COMMAND_LOG;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub clone and refresh normalize HTTPS and bare remotes through the capability proxy", async () => {
  const root = await mkdtemp(join(tmpdir(), "codevil-git-proxy-normalization-"));
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  const commandLog = join(root, "git-commands.jsonl");
  const originalPath = process.env.PATH;

  try {
    await mkdir(join(checkout, ".git"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "git"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.CODEVIL_GIT_COMMAND_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
    await chmod(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.CODEVIL_GIT_COMMAND_LOG = commandLog;

    const driver = new ShellGitDriver({
      proxyBase: "https://worker.example/base/",
      proxySessionId: "session-1",
      gitProxyCapability: "capability",
    });
    await driver.clone("https://github.com/example/app", join(root, "clone"), () => {});
    await driver.refresh("github.com/example/app", checkout, () => {});

    const commands = (await readFile(commandLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const proxyUrl = "https://worker.example/sandbox-proxy/sessions/session-1/github/example/app.git";
    assert.ok(commands.some((args) => args.includes(proxyUrl)), "clone uses proxy URL");
    assert.ok(commands.some((args) => args.includes("set-url") && args.includes(proxyUrl)), "refresh uses proxy URL");
    assert.ok(!commands.flat().some((argument) => argument === "https://github.com/example/app" || argument === "github.com/example/app"));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    delete process.env.CODEVIL_GIT_COMMAND_LOG;
    await rm(root, { recursive: true, force: true });
  }
});

test("configured Git proxy fails closed instead of falling back to unsafe or non-GitHub remotes", async () => {
  const driver = new ShellGitDriver({
    proxyBase: "https://worker.example",
    proxySessionId: "session-1",
    gitProxyCapability: "capability",
  });

  for (const repo of [
    "https://github.com/example/app.git/extra",
    "https://github.com@example.evil/example/app.git",
    "https://gitlab.com/example/app.git",
  ]) {
    await assert.rejects(() => driver.clone(repo, "/tmp/never-clone", () => {}), /Git proxy only permits canonical GitHub repository URLs/);
  }
});

test("runGitCommand rejects when a command exceeds its timeout", async () => {
  await assert.rejects(
    () => runGitCommand("node", ["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 100 }),
    /node -e setTimeout\(\(\) => \{\}, 60_000\) timed out after 100ms/,
  );
});
