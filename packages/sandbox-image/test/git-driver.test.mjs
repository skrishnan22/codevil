import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  configureDefaultGitIdentity,
  configureGitProxyCredentials,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  runGitCommand,
  ShellGitDriver,
  shallowCloneArgs,
  updateGitProxyCapability,
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

test("refresh configures transparent proxy credentials without persisting the capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "codevil-git-proxy-refresh-"));
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const commandLog = join(root, "git-commands.jsonl");
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const capability = "git-capability-that-must-not-persist";

  try {
    await mkdir(join(checkout, ".git"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(checkout, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    await writeFile(join(bin, "git"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.CODEVIL_GIT_COMMAND_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
    await chmod(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.HOME = home;
    process.env.CODEVIL_GIT_COMMAND_LOG = commandLog;

    const driver = new ShellGitDriver({
      proxyBase: "https://worker.example",
      proxySessionId: "session-1",
      gitProxyCapability: capability,
    });
    await driver.refresh("https://github.com/example/app.git", checkout, () => {});

    const commands = (await readFile(commandLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const fetch = commands.find((args) => args.includes("fetch"));
    const setHead = commands.find((args) => args.includes("set-head"));
    const setUrl = commands.find((args) => args.includes("set-url"));

    assert.ok(fetch);
    assert.ok(setHead);
    assert.ok(setUrl);
    assert.ok(!commands.flat().some((argument) => argument.includes(capability)));
    assert.doesNotMatch(await readFile(join(checkout, ".git", "config"), "utf8"), new RegExp(capability));
    assert.equal((await stat(join(home, ".codevil", "git-proxy-capability"))).mode & 0o777, 0o600);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.CODEVIL_GIT_COMMAND_LOG;
    await rm(root, { recursive: true, force: true });
  }
});

test("credential helper supplies refreshed capability only to the session proxy route", async () => {
  const home = await mkdtemp(join(tmpdir(), "codevil-git-credential-helper-"));
  const previousHome = process.env.HOME;
  const proxyBase = "https://worker.example";
  const route = "/sandbox-proxy/sessions/session-1/github/example/app.git";

  try {
    process.env.HOME = home;
    await configureGitProxyCredentials({ proxyBase, proxySessionId: "session-1", gitProxyCapability: "initial-capability" });

    const fill = async (host, path) => {
      const input = `protocol=https\nhost=${host}\npath=${path}\n\n`;
      return credentialFill(input);
    };

    assert.match(await fill("worker.example", route), /username=x-access-token\npassword=initial-capability\n/);
    assert.match(await fill("worker.example", route.replace(".git", "")), /username=x-access-token\npassword=initial-capability\n/);
    assert.match(await fill("worker.example", `${route.replace(".git", "")}/info/refs`), /username=x-access-token\npassword=initial-capability\n/);
    await updateGitProxyCapability("refreshed-capability");
    assert.match(await fill("worker.example", route), /password=refreshed-capability\n/);
    const helperPath = join(home, ".codevil", "git-proxy-credential-helper.cjs");
    assert.equal(await invokeCredentialHelper(helperPath, "github.com", "/example/app.git"), "");
    assert.equal(await invokeCredentialHelper(helperPath, "worker.example", "/sandbox-proxy/sessions/other/github/example/app.git"), "");
    assert.equal(await invokeCredentialHelper(helperPath, "worker.example", "/sandbox-proxy/sessions/session-1/llm/anthropic/messages/"), "");
    assert.doesNotMatch(await readFile(join(home, ".gitconfig"), "utf8"), /refreshed-capability|initial-capability/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("Git rewrites HTTPS and SSH GitHub URLs to the session proxy, whose bare route is canonicalized to .git", async () => {
  const home = await mkdtemp(join(tmpdir(), "codevil-git-rewrite-"));
  const previousHome = process.env.HOME;
  const proxyPrefix = "https://worker.example/sandbox-proxy/sessions/session-1/github/";

  try {
    process.env.HOME = home;
    await configureGitProxyCredentials({ proxyBase: "https://worker.example", proxySessionId: "session-1", gitProxyCapability: "capability" });

    for (const [input, expected] of [
      ["https://github.com/example/app", `${proxyPrefix}example/app`],
      ["git@github.com:example/app", `${proxyPrefix}example/app`],
      ["ssh://git@github.com/example/app", `${proxyPrefix}example/app`],
      ["https://github.com/example/app.git", `${proxyPrefix}example/app.git`],
      ["ssh://git@github.com/example/app.git", `${proxyPrefix}example/app.git`],
    ]) {
      const rewritten = await gitTraceRemoteUrl(input);
      assert.equal(rewritten, expected, input);
    }

    // insteadOf is necessarily prefix-based. A nested path is rewritten but
    // cannot obtain the capability, and the Worker rejects it independently.
    const unsafeProxyPath = await gitTraceRemoteUrl("https://github.com/example/app/extra");
    assert.equal(unsafeProxyPath, `${proxyPrefix}example/app/extra`);
    const helperPath = join(home, ".codevil", "git-proxy-credential-helper.cjs");
    assert.equal(await invokeCredentialHelper(helperPath, "worker.example", new URL(unsafeProxyPath).pathname), "");
    assert.equal(await gitTraceRemoteUrl("https://github.com.evil/example/app"), "https://github.com.evil/example/app");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

function credentialFill(input) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["credential", "fill"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `git credential fill exited ${code}`)));
    child.stdin.end(input);
  });
}

function invokeCredentialHelper(helperPath, host, path) {
  return credentialFillProcess("node", [helperPath, "get"], `protocol=https\nhost=${host}\npath=${path}\n\n`);
}

async function gitTraceRemoteUrl(url) {
  try {
    await execFileAsync("git", ["ls-remote", url], {
      env: { ...process.env, GIT_TRACE: "1", GIT_TERMINAL_PROMPT: "0" },
      timeout: 10_000,
    });
    throw new Error("expected GitHub proxy URL to be unreachable during this integration test");
  } catch (error) {
    const trace = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    const match = trace.match(/git remote-https [^\s]+ (https:\/\/[^\s']+)/);
    if (!match) throw error;
    return match[1];
  }
}

function credentialFillProcess(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `${command} exited ${code}`)));
    child.stdin.end(input);
  });
}

test("GitHub clone and refresh normalize HTTPS and bare remotes through the capability proxy", async () => {
  const root = await mkdtemp(join(tmpdir(), "codevil-git-proxy-normalization-"));
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  const commandLog = join(root, "git-commands.jsonl");
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;

  try {
    await mkdir(join(checkout, ".git"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(join(bin, "git"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.CODEVIL_GIT_COMMAND_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
    await chmod(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.HOME = join(root, "home");
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
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.CODEVIL_GIT_COMMAND_LOG;
    await rm(root, { recursive: true, force: true });
  }
});

test("configured Git proxy fails closed instead of falling back to unsafe or non-GitHub remotes", async () => {
  const home = await mkdtemp(join(tmpdir(), "codevil-git-proxy-reject-"));
  const previousHome = process.env.HOME;
  const driver = new ShellGitDriver({
    proxyBase: "https://worker.example",
    proxySessionId: "session-1",
    gitProxyCapability: "capability",
  });

  try {
    process.env.HOME = home;
    for (const repo of [
      "https://github.com/example/app.git/extra",
      "https://github.com@example.evil/example/app.git",
      "https://gitlab.com/example/app.git",
    ]) {
      await assert.rejects(() => driver.clone(repo, "/tmp/never-clone", () => {}), /Git proxy only permits canonical GitHub repository URLs/);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("runGitCommand rejects when a command exceeds its timeout", async () => {
  await assert.rejects(
    () => runGitCommand("node", ["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 100 }),
    /node -e setTimeout\(\(\) => \{\}, 60_000\) timed out after 100ms/,
  );
});
