# E2B Sandbox Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put Codevil's sandbox behind a provider-neutral interface, add an E2B adapter as the default provider, and pause idle E2B sandboxes.

**Architecture:** A `SandboxProvider` factory returns a `SandboxHandle` (Flue-style adapter pattern plus lifecycle, background process, and port methods). The Orchestrator Durable Object stores the provider name and a `SandboxRef` on `SessionMeta` and talks only to the interface. The Cloudflare adapter wraps today's `@cloudflare/sandbox` code unchanged; the E2B adapter uses the `e2b` JS SDK from inside the Worker. Idle pause is driven by the Orchestrator's existing alarm loop.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects (workerd, `nodejs_compat`), `@cloudflare/sandbox` 0.12.7, `e2b` JS SDK v2, zod, `node:test` (tests are `.mjs` files that import from `dist/` after `tsc`), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-01-e2b-sandbox-provider-design.md`

## Global Constraints

- Provider credentials, the GitHub PAT, `E2B_API_KEY`, and the E2B traffic access token never enter the sandbox and never appear unredacted in logs, broadcasts, or HTTP responses.
- `SANDBOX_PROVIDER` values: `e2b` | `cloudflare`; default `e2b` (from Task 4 onward; `cloudflare` until then). Read once at Session creation; stored as `meta.sandbox_provider`. Missing on legacy Sessions → `cloudflare`.
- `E2B_TEMPLATE_ID` default `codevil-sandbox`; `E2B_MAX_SANDBOX_SECONDS` default `3600`.
- E2B sandboxes: 2 vCPU / 4096 MiB template; created with `secure: true`, `allowPublicTraffic: false`.
- Preview traffic to E2B carries header `e2b-traffic-access-token`.
- Agent WS token file: `/run/codevil/ws-token`, mode `0600`, owner `codevil` (UID/GID 10001).
- Agent logs on E2B: `/var/log/codevil/<processId>.out` and `.err`; `readProcessLogs` returns the last 64 KiB (65536 bytes) of each.
- `max_idle_time` default `10m`. Preview wait-for-resume timeout: 15 seconds, then 503.
- Resume retries: 3. Lease renewal interval: 5 minutes.
- Cloudflare behavior (keepalive, `sleepAfter = "10m"`, lifecycle hooks, workspace cache) must not change. Existing worker tests keep their assertions.
- Worker tests: `pnpm --filter @codevil/worker test` (builds, then `node --test test/*.test.mjs`). Sandbox-image tests: `pnpm --filter @codevil/sandbox-image test`. Shared: `pnpm --filter @codevil/shared test`. Full gate: `pnpm verify`.
- Commit after every task with a conventional message (`feat(sandbox): …`, `refactor(sandbox): …`). Work on the current branch `t3code/443d5acd`; never on `main`.

## Task Ordering

Tasks 1, 3, 5, and 6 do not touch E2B and may run while Task 2 (the feasibility gate) waits for an `E2B_API_KEY`. Tasks 4, 7, 8, and 9 start only after Task 2 passes. If Task 2 fails, stop after the provider-neutral tasks and report.

## Review Focus

1. **Pause while the agent is mid-reconnect or cloning** — a sandbox in `cloning_repo` or with `sandbox_disconnected_at` set must never be paused (state must be `ready`, socket attached). Test owned by Task 6.
2. **Agent Request arriving while a resume is already in flight** — two triggers (prompt + preview) must share one resume, and the queued run must start after the agent reconnects, not be dropped or doubled. Test owned by Task 7.
3. **Resumed agent reconnect rejected as "not expected"** — after pause the DO must close its own sandbox sockets so `sandboxConnectionMode` sees `attachedSandboxCount === 0` and returns `"resume"`, not `"reject"` and not `"initialize"` (which would re-clone). Test owned by Task 7.
4. **Session ends while paused** — `max_time`, user stop, and failure must destroy a paused E2B sandbox (paused sandboxes never expire). Test owned by Task 7.
5. **Secrets leaking through E2B errors or diagnostics** — E2B SDK error messages, the traffic token, and `E2B_API_KEY` must pass through redaction. Test owned by Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/worker/src/sandbox-provider/types.ts` (create) | `SandboxProvider`, `SandboxHandle`, `SandboxRef`, `ShellResult`, `SandboxNotFoundError`, `SandboxProviderName`, `parseSandboxProviderName`. |
| `packages/worker/src/sandbox-provider/cloudflare.ts` (create) | Cloudflare adapter wrapping existing `sandbox.ts` helpers. |
| `packages/worker/src/sandbox-provider/e2b.ts` (create, Task 4) | E2B adapter; SDK injected for tests. |
| `packages/worker/src/sandbox-provider/index.ts` (create) | `configuredSandboxProviderName(env)`, `resolveSandboxProvider(env, name)`. |
| `packages/worker/src/sandbox.ts` (modify) | Keep helpers; `provisionSandbox` becomes provider-neutral `startAgentOnHandle`. |
| `packages/worker/src/orchestrator/sandbox-lifecycle.ts` (create, Task 6) | Pure helpers: idle deadline, pause decision, lease length. |
| `packages/worker/src/orchestrator/sandbox-resume.ts` (create, Task 7) | Pause/resume/renew/destroy orchestration against `OrchestratorHost`. |
| `packages/worker/src/orchestrator/{host,types,alarm,preview,sandbox-handlers,cli-handlers}.ts` (modify) | Use the interface; idle/lease deadlines. |
| `packages/worker/src/{orchestrator,http-handlers,session-service,worker-env}.ts` (modify) | Store provider/ref, route logs/diagnostics via DO, config. |
| `packages/shared/src/{session-meta-schema,room}.ts` (modify) | New meta fields; `paused` sandbox state. |
| `packages/sandbox-image/src/entrypoint.ts` (modify, Task 5) | Reread WS token file on reconnect. |
| `Dockerfile.sandbox`, `packages/sandbox-image/scripts/e2b-template.mjs`, `packages/sandbox-image/package.json` (modify/create, Task 8) | Shared image for both providers; E2B template publish. |

---

### Task 1: Provider interface and Cloudflare adapter (pure refactor)

**Files:**
- Create: `packages/worker/src/sandbox-provider/types.ts`, `packages/worker/src/sandbox-provider/cloudflare.ts`, `packages/worker/src/sandbox-provider/index.ts`
- Modify: `packages/worker/src/sandbox.ts`, `packages/worker/src/orchestrator/sandbox-handlers.ts`, `packages/worker/src/orchestrator.ts`, `packages/worker/src/orchestrator/preview.ts`, `packages/worker/src/orchestrator/host.ts`, `packages/worker/src/orchestrator/types.ts`, `packages/worker/src/http-handlers.ts`, `packages/worker/src/http-router.ts`, `packages/worker/src/session-service.ts`, `packages/worker/src/workspace-cache.ts`, `packages/shared/src/session-meta-schema.ts`, `packages/worker/test/helpers/fake-host.mjs`
- Test: `packages/worker/test/sandbox-provider-cloudflare.test.mjs` (create), plus all existing worker tests

**Interfaces:**
- Produces (used by every later task):

```ts
// packages/worker/src/sandbox-provider/types.ts
export type SandboxProviderName = "e2b" | "cloudflare";
export const SANDBOX_PROVIDER_NAMES: readonly SandboxProviderName[] = ["e2b", "cloudflare"];

export interface SandboxRef { provider: SandboxProviderName; id: string }
export interface ShellResult { stdout: string; stderr: string; exitCode: number }
export interface SandboxLifecycleView {
  keepAlive?: { active: boolean; reason?: string; updated_at?: string };
  lastEvent?: { type: string; at: string; exit_code?: number; reason?: string; error?: string };
}

export interface SandboxProvider {
  readonly name: SandboxProviderName;
  readonly capabilities: { pauseResume: boolean; workspaceCache: boolean };
  create(options: { sessionId: string; leaseMs: number }): Promise<SandboxHandle>;
  /** `secret` is the opaque value returned as `handle.secret` at create time. */
  connect(ref: SandboxRef, options?: { leaseMs?: number; secret?: string }): Promise<SandboxHandle>;
}

export interface SandboxHandle {
  readonly ref: SandboxRef;
  /** Provider-specific secret the Orchestrator must persist and redact (E2B traffic token). */
  readonly secret?: string;
  exec(command: string, options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; user?: "root" | "codevil" }): Promise<ShellResult>;
  writeFile(path: string, content: string, options?: { mode?: number; owner?: "root" | "codevil" }): Promise<void>;
  startProcess(command: string, options: { processId: string; cwd: string; env: Record<string, string> }): Promise<void>;
  readProcessLogs(processId: string): Promise<{ stdout: string; stderr: string }>;
  readLifecycle?(): Promise<SandboxLifecycleView | null>;
  fetchPort(port: number, request: Request): Promise<Response>;
  renewLease(ms: number): Promise<void>;
  pause?(): Promise<void>;
  destroy(reason: string): Promise<void>;
  /** Present only when provider.capabilities.workspaceCache is true. */
  readonly workspaceCache?: import("../workspace-cache.js").WorkspaceCacheSandbox;
}

export class SandboxNotFoundError extends Error {
  constructor(message = "Sandbox not found") { super(message); this.name = "SandboxNotFoundError"; }
}

export function parseSandboxProviderName(value: unknown): SandboxProviderName | undefined {
  return typeof value === "string" && (SANDBOX_PROVIDER_NAMES as readonly string[]).includes(value)
    ? value as SandboxProviderName
    : undefined;
}
```

```ts
// packages/worker/src/sandbox-provider/index.ts
export function configuredSandboxProviderName(env: Pick<Env, "SANDBOX_PROVIDER">): SandboxProviderName; // Task 1: always "cloudflare" unless env says "cloudflare"; unknown → throws Error("Unsupported SANDBOX_PROVIDER")
export function resolveSandboxProvider(env: Env, name: SandboxProviderName): SandboxProvider;          // Task 1: "e2b" → throws Error("E2B sandbox provider is not available")
export function sandboxProviderForMeta(env: Env, meta: { sandbox_provider?: string }): SandboxProvider; // missing → cloudflare
```

- `SessionMeta` gains (shared schema, all optional): `sandbox_provider: z.enum(["e2b","cloudflare"]).optional()`, `sandbox_ref: z.object({ provider: z.enum(["e2b","cloudflare"]), id: z.string() }).optional()`.
- `InitOptions` gains `sandbox_provider?: "e2b" | "cloudflare"`.
- `OrchestratorHost` gains `sandboxProvider(): SandboxProvider` and `sandboxHandle(): Promise<SandboxHandle | null>` (null when `meta.sandbox_ref` is unset).
- Orchestrator gains RPC methods `readSandboxLogs(): Promise<Response>` and `readSandboxDiagnosticsResponse(): Promise<Response>` used by `handleLogs` / `handleDiagnostics`.
- `Env` gains `SANDBOX_PROVIDER?: string`.

Cloudflare adapter behavior (must match today exactly):

| Method | Implementation |
|---|---|
| `create({ sessionId })` | `getCodevilSandbox(getSandbox, env.Sandbox, sessionId)`; then `retrySandboxOperation(() => setCodevilSandboxKeepAlive(sandbox, true, "session provisioning"))`. `ref = { provider: "cloudflare", id: sessionId }`. |
| `connect(ref)` | `getCodevilSandbox(getSandbox, env.Sandbox, ref.id)` (no keepalive change). |
| `startProcess` | `retrySandboxOperation(() => sandbox.startProcess(command, { cwd, env, processId, autoCleanup: true }))`. |
| `readProcessLogs` | `sandbox.getProcessLogs(processId)`. |
| `readLifecycle` | `sandbox.getCodevilLifecycleSnapshot?.() ?? null`. |
| `fetchPort(port, request)` | Clone headers, set `cf-container-target-port: String(port)`, return `sandbox.fetch(new Request(request, { headers }))`. |
| `exec` | `sandbox.exec(command, { cwd, env, timeout: timeoutMs })` mapped to `{ stdout, stderr, exitCode }`. |
| `writeFile` | `sandbox.writeFile(path, content)` then `exec("chmod <octal> <path> && chown <uid>:<gid> <path>")` when options given (owner `codevil` → `10001:10001`, `root` → `0:0`). |
| `renewLease` | no-op. |
| `pause` | absent. |
| `destroy(reason)` | `setCodevilSandboxKeepAlive(sandbox, false, reason)` then `sandbox.stop()`. |
| `workspaceCache` | the sandbox itself (it already satisfies `WorkspaceCacheSandbox`). |
| `capabilities` | `{ pauseResume: false, workspaceCache: true }`. |

Call-site rewiring:
- `provisionSessionSandbox` (`orchestrator/sandbox-handlers.ts:47`): `const provider = host.sandboxProvider()`; `const handle = await provider.create({ sessionId, leaseMs })` where `leaseMs = parseMaxTimeMs(meta.max_time) ?? 3_600_000`; store `meta.sandbox_ref = handle.ref` and `saveMeta()`; if `handle.secret`, `await host.ctx.storage.put("codevil:sandbox_secret", handle.secret)`; if `provider.capabilities.workspaceCache && handle.workspaceCache`, run the existing restore; then `await startAgentOnHandle(handle, envOptions)`.
- `sandbox.ts`: replace `provisionSandbox`/`provisionSandboxOnInstance` with `startAgentOnHandle(handle: SandboxHandle, options: SandboxProcessEnvOptions): Promise<void>` that calls `handle.startProcess(AGENT_COMMAND, { processId: "codevil-agent", cwd: "/workspace", env: sandboxProcessEnv(options) })`. Export `AGENT_COMMAND` (today's exact string). Update `test/sandbox.test.mjs` imports that referenced `provisionSandboxOnInstance` to cover `startAgentOnHandle` with a fake handle asserting the same command, cwd, env, processId.
- `terminateSandbox` (`orchestrator.ts:754`): `const handle = await this.sandboxHandle(); await handle?.destroy(reason)` inside the existing try/catch.
- `readProcessLogs` in the provisioning-timeout path (`orchestrator.ts:~325`): use `handle.readProcessLogs("codevil-agent")` with redaction; null on error.
- `logSandboxDisconnectDiagnostics`: build a reader `{ getProcessLogs: (id) => handle.readProcessLogs(id), getCodevilLifecycleSnapshot: handle.readLifecycle ? () => handle.readLifecycle() : undefined }` and call `collectSandboxDiagnostics`.
- `proxyPreviewRequest` (`orchestrator/preview.ts`): signature becomes `(request, meta, token, handle: SandboxHandle | null)`; return `404 "Preview is not active."` when handle is null; replace `portedHeaders.set("cf-container-target-port", …)` + `sandbox.fetch` with `handle.fetchPort(previewPort, portedRequest)` inside `fetchPreviewWithRetries` (change its first parameter to `fetchOnce: (request: Request) => Promise<Response>`).
- `handleLogs` / `handleDiagnostics` (`http-handlers.ts:723-750`): call `env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName(sessionId)).readSandboxLogs()` / `.readSandboxDiagnosticsResponse()`; the DO methods return the same JSON bodies and status codes as today (`{ error: "Failed to read sandbox logs" }` 500 on failure).
- Workspace cache job: `createWorkspaceCacheSnapshotForSandbox` takes the `WorkspaceCacheSandbox` from `(await host.sandboxHandle())?.workspaceCache`; when absent, the job is marked done without a snapshot. `enqueueWorkspaceCacheJob` call at `sandbox-handlers.ts:338` is guarded by `host.sandboxProvider().capabilities.workspaceCache`.
- Session creation (`session-service.ts` and `http-handlers.ts` `stub.init` calls): pass `sandbox_provider: configuredSandboxProviderName(env)`; `Orchestrator.init` stores it on meta.

- [ ] **Step 1: Write the failing adapter test** — `packages/worker/test/sandbox-provider-cloudflare.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { createCloudflareSandboxProvider } from "../dist/sandbox-provider/cloudflare.js";
import { parseSandboxProviderName, SandboxNotFoundError } from "../dist/sandbox-provider/types.js";
import { sandboxProviderForMeta, configuredSandboxProviderName } from "../dist/sandbox-provider/index.js";

function fakeCloudflareSandbox() {
  const calls = [];
  return {
    calls,
    setKeepAlive: async (active) => { calls.push(["setKeepAlive", active]); },
    setCodevilKeepAlive: async (active, reason) => { calls.push(["setCodevilKeepAlive", active, reason]); },
    startProcess: async (command, options) => { calls.push(["startProcess", command, options]); },
    getProcessLogs: async (id) => ({ stdout: `out:${id}`, stderr: "" }),
    getCodevilLifecycleSnapshot: async () => ({ lastEvent: { type: "start", at: "t" } }),
    fetch: async (request) => { calls.push(["fetch", request.headers.get("cf-container-target-port")]); return new Response("ok"); },
    stop: async () => { calls.push(["stop"]); },
  };
}

function providerWith(sandbox) {
  const seen = [];
  const provider = createCloudflareSandboxProvider({
    binding: {},
    getSandbox: (_binding, id, options) => { seen.push([id, options]); return sandbox; },
  });
  return { provider, seen };
}

test("cloudflare create enables keepalive and uses the session id as the ref", async () => {
  const sandbox = fakeCloudflareSandbox();
  const { provider, seen } = providerWith(sandbox);
  const handle = await provider.create({ sessionId: "ses_1", leaseMs: 60_000 });
  assert.deepEqual(handle.ref, { provider: "cloudflare", id: "ses_1" });
  assert.deepEqual(seen, [["ses_1", { keepAlive: true }]]);
  assert.deepEqual(sandbox.calls, [["setKeepAlive", true], ["setCodevilKeepAlive", true, "session provisioning"]]);
  assert.deepEqual(provider.capabilities, { pauseResume: false, workspaceCache: true });
  assert.equal(handle.pause, undefined);
  assert.equal(handle.workspaceCache, sandbox);
});

test("cloudflare startProcess keeps processId and autoCleanup", async () => {
  const sandbox = fakeCloudflareSandbox();
  const { provider } = providerWith(sandbox);
  const handle = await provider.connect({ provider: "cloudflare", id: "ses_1" });
  await handle.startProcess("node x", { processId: "codevil-agent", cwd: "/workspace", env: { A: "1" } });
  assert.deepEqual(sandbox.calls, [["startProcess", "node x", { cwd: "/workspace", env: { A: "1" }, processId: "codevil-agent", autoCleanup: true }]]);
});

test("cloudflare fetchPort routes by the container target-port header", async () => {
  const sandbox = fakeCloudflareSandbox();
  const { provider } = providerWith(sandbox);
  const handle = await provider.connect({ provider: "cloudflare", id: "ses_1" });
  const response = await handle.fetchPort(5173, new Request("http://localhost/"));
  assert.equal(await response.text(), "ok");
  assert.deepEqual(sandbox.calls, [["fetch", "5173"]]);
});

test("cloudflare destroy clears keepalive before stopping", async () => {
  const sandbox = fakeCloudflareSandbox();
  const { provider } = providerWith(sandbox);
  const handle = await provider.connect({ provider: "cloudflare", id: "ses_1" });
  await handle.destroy("stopped by user");
  assert.deepEqual(sandbox.calls, [["setKeepAlive", false], ["setCodevilKeepAlive", false, "stopped by user"], ["stop"]]);
});

test("cloudflare readProcessLogs and readLifecycle pass through", async () => {
  const { provider } = providerWith(fakeCloudflareSandbox());
  const handle = await provider.connect({ provider: "cloudflare", id: "ses_1" });
  assert.deepEqual(await handle.readProcessLogs("codevil-agent"), { stdout: "out:codevil-agent", stderr: "" });
  assert.deepEqual(await handle.readLifecycle(), { lastEvent: { type: "start", at: "t" } });
});

test("provider name parsing and legacy meta default", () => {
  assert.equal(parseSandboxProviderName("e2b"), "e2b");
  assert.equal(parseSandboxProviderName("modal"), undefined);
  assert.equal(new SandboxNotFoundError().name, "SandboxNotFoundError");
  assert.equal(configuredSandboxProviderName({}), "cloudflare");
  assert.throws(() => configuredSandboxProviderName({ SANDBOX_PROVIDER: "modal" }), /Unsupported SANDBOX_PROVIDER/);
  const provider = sandboxProviderForMeta({ Sandbox: {} }, {});
  assert.equal(provider.name, "cloudflare");
});
```

`createCloudflareSandboxProvider({ binding, getSandbox })` takes `getSandbox` injected (default: dynamic `import("@cloudflare/sandbox")` inside `resolveSandboxProvider`), so tests never load the real SDK.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @codevil/worker test`
Expected: FAIL — `Cannot find module '../dist/sandbox-provider/cloudflare.js'`.

- [ ] **Step 3: Implement** `types.ts` (code above), `cloudflare.ts` per the behavior table, `index.ts`. Because `getSandbox` is async-imported in production, `resolveSandboxProvider` returns a provider whose methods `await import("@cloudflare/sandbox")` lazily when no `getSandbox` override is given:

```ts
// packages/worker/src/sandbox-provider/index.ts
import type { Env } from "../worker-env.js";
import { createCloudflareSandboxProvider } from "./cloudflare.js";
import { parseSandboxProviderName, type SandboxProvider, type SandboxProviderName } from "./types.js";

export function configuredSandboxProviderName(env: { SANDBOX_PROVIDER?: string }): SandboxProviderName {
  const raw = env.SANDBOX_PROVIDER?.trim();
  if (!raw) return "cloudflare";
  const name = parseSandboxProviderName(raw);
  if (!name) throw new Error("Unsupported SANDBOX_PROVIDER");
  return name;
}

export function resolveSandboxProvider(env: Env, name: SandboxProviderName): SandboxProvider {
  if (name === "cloudflare") return createCloudflareSandboxProvider({ binding: env.Sandbox });
  throw new Error("E2B sandbox provider is not available");
}

export function sandboxProviderForMeta(env: Env, meta: { sandbox_provider?: string }): SandboxProvider {
  return resolveSandboxProvider(env, parseSandboxProviderName(meta.sandbox_provider) ?? "cloudflare");
}
```

- [ ] **Step 4: Rewire the call sites** listed above. Add `sandbox_provider` / `sandbox_ref` to `SessionMetaSchema` and `sandbox_provider` to `InitOptions`; `Orchestrator.init` sets `sandbox_provider: options.sandbox_provider ?? "cloudflare"`. Implement on `Orchestrator`:

```ts
sandboxProvider(): SandboxProvider {
  return sandboxProviderForMeta(this.workerEnv, this.meta ?? {});
}

async sandboxHandle(): Promise<SandboxHandle | null> {
  const ref = this.meta?.sandbox_ref
    ?? (this.meta && this.sandboxProvider().name === "cloudflare"
      ? { provider: "cloudflare" as const, id: this.meta.session_id }
      : undefined);
  if (!ref) return null;
  const secret = await this.ctx.storage.get<string>("codevil:sandbox_secret");
  return this.sandboxProvider().connect(ref, secret ? { secret } : undefined);
}
```

(The Cloudflare fallback keeps legacy Sessions without `sandbox_ref` working.) Add both to `OrchestratorHost` and to `createFakeHost` in `test/helpers/fake-host.mjs` (`options.sandboxHandle` and `options.sandboxProvider` overrides; defaults return a Cloudflare-like fake with `capabilities: { pauseResume: false, workspaceCache: true }`).

- [ ] **Step 5: Run the whole worker suite and typecheck**

Run: `pnpm --filter @codevil/worker typecheck && pnpm --filter @codevil/worker test && pnpm --filter @codevil/shared test`
Expected: all pass, including every pre-existing test with unchanged assertions (only import-path adjustments for removed `provisionSandboxOnInstance` are allowed).

- [ ] **Step 6: Commit**

```bash
git add packages/worker packages/shared
git commit -m "refactor(sandbox): route sandbox access through a provider interface"
```

---

### Task 2: E2B feasibility gate (throwaway probe)

**Requires:** a real `E2B_API_KEY`. If it is not available in `packages/worker/.dev.vars` or the environment, STOP and report `BLOCKED: needs E2B_API_KEY`. Do not fake results.

**Files:**
- Create (throwaway, never committed): `packages/worker/probe/e2b-probe.ts`, `packages/worker/probe/wrangler.probe.toml`
- Modify (committed): `docs/superpowers/specs/2026-10-01-e2b-sandbox-provider-design.md` — append a `## Feasibility Findings` section
- Modify (committed): `packages/worker/package.json` — add dependency `e2b` (latest 2.x; record exact version)

**Interfaces:**
- Produces: written answers that Tasks 4 and 8 rely on: SDK runs in workerd (yes/no + any required import path or polyfill), WebSocket upgrade through `getHost(port)` with token works (yes/no), whether `Sandbox.connect` repopulates `trafficAccessToken`, Hobby 1-hour clock behavior after resume, template publish command.

- [ ] **Step 1:** `pnpm --filter @codevil/worker add e2b@^2`
- [ ] **Step 2:** Write `probe/wrangler.probe.toml`:

```toml
name = "codevil-e2b-probe"
main = "e2b-probe.ts"
compatibility_date = "2026-04-07"
compatibility_flags = ["nodejs_compat"]
```

- [ ] **Step 3:** Write `probe/e2b-probe.ts` — a Worker whose `fetch` runs, in order, and returns a JSON report of each step's result or error message:
  1. `Sandbox.create({ apiKey, timeoutMs: 300_000, secure: true, allowPublicTraffic: false })` (default `base` template).
  2. `commands.run("echo hi")` → expect stdout `hi\n`.
  3. `files.write("/tmp/x", "y")` then `commands.run("cat /tmp/x")`.
  4. `commands.run("python3 -m http.server 8000", { background: true })`, wait 2s, Worker `fetch("https://" + sandbox.getHost(8000) + "/", { headers: { "e2b-traffic-access-token": sandbox.trafficAccessToken } })` → expect 200; same without the header → expect 403.
  5. Start a WebSocket echo server: `commands.run("npx -y wscat --listen 8001", { background: true })` (or `python3 -c` with `websockets` if available); Worker `fetch(url, { headers: { Upgrade: "websocket", "e2b-traffic-access-token": token } })` → expect `response.status === 101` and `response.webSocket` non-null; send/receive one message.
  6. `sandbox.pause()`; then `Sandbox.connect(sandboxId, { apiKey, timeoutMs: 300_000 })`; record resume duration, whether `trafficAccessToken` is set on the connected instance, and whether the background server from step 4 still answers.
  7. `sandbox.setTimeout(120_000)`; `sandbox.kill()`; `Sandbox.connect(killedId)` → record the error class name (expect `NotFoundError`).
- [ ] **Step 4:** Run `pnpm --filter @codevil/worker exec wrangler dev -c probe/wrangler.probe.toml --var E2B_API_KEY:$E2B_API_KEY`, `curl localhost:8787`, save the JSON.
- [ ] **Step 5:** Hobby clock: check E2B docs/dashboard for the max-timeout rule on Hobby; if resume resets it, record "resets"; otherwise record the observed limit.
- [ ] **Step 6:** Template publishing: confirm which of `e2b template build` (CLI, Dockerfile) or the v2 Template SDK (`Template().fromDockerfile(...)` / `fromImage(...)`) accepts a multi-stage Dockerfile; record the exact command.
- [ ] **Step 7:** Append `## Feasibility Findings` to the spec with the JSON results, the `e2b` version, and the answers above. Delete `packages/worker/probe/`.
- [ ] **Step 8:** Decision. If step 1–3 failed in workerd: commit only the findings, report `GATE FAILED`, and stop the plan. Otherwise commit:

```bash
git add docs/superpowers/specs/2026-10-01-e2b-sandbox-provider-design.md packages/worker/package.json pnpm-lock.yaml
git commit -m "docs(sandbox): record E2B feasibility findings"
```

---

### Task 3: Shared schema and config plumbing for idle pause

**Files:**
- Modify: `packages/shared/src/room.ts` (`SandboxStateSchema` add `"paused"`), `packages/shared/src/session-meta-schema.ts`, `packages/worker/src/orchestrator/types.ts` (`InitOptions.max_idle_time?: string`), `packages/worker/src/orchestrator.ts` (`init`), `packages/worker/src/session-service.ts`, `packages/worker/src/http-handlers.ts` (pass `max_idle_time: normalized.max_idle_time`)
- Modify: web labels if a `SandboxState` → label map exists (`grep -rn "timed_out" packages/web/src` and add `paused: "Paused"` wherever sandbox states are mapped)
- Test: `packages/shared/test/session.test.mjs` or a new `packages/shared/test/session-meta-schema.test.mjs`, `packages/worker/test/session-service.test.mjs`

**Interfaces:**
- Produces on `SessionMeta` (all optional): `max_idle_time: z.string()`, `last_activity_at: z.string()`, `sandbox_paused_at: z.string()`, `sandbox_lease_renewed_at: z.string()`.
- `Orchestrator.init` sets `max_idle_time: options.max_idle_time ?? "10m"`, `last_activity_at: created_at`.

- [ ] **Step 1: Failing tests**

```js
// packages/shared/test/session-meta-schema.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { SessionMetaSchema, SandboxStateSchema } from "../dist/index.js";

test("session meta accepts idle-pause and provider fields", () => {
  const parsed = SessionMetaSchema.parse({
    session_id: "ses_1", prompt: "", repo: "r", worker_url: "https://w", provider: "openai",
    plan_model: "m", exec_model: "m", max_time: "30m", state: "ready", refinement_round: 0,
    verification_attempts: 0, cost_total_usd: 0, created_at: "2026-10-01T00:00:00.000Z",
    sandbox_provider: "e2b", sandbox_ref: { provider: "e2b", id: "sbx_1" },
    max_idle_time: "10m", last_activity_at: "2026-10-01T00:00:00.000Z",
    sandbox_paused_at: "2026-10-01T00:10:00.000Z", sandbox_lease_renewed_at: "2026-10-01T00:05:00.000Z",
  });
  assert.equal(parsed.sandbox_ref.id, "sbx_1");
  assert.equal(parsed.max_idle_time, "10m");
});

test("sandbox state includes paused", () => {
  assert.equal(SandboxStateSchema.parse("paused"), "paused");
});
```

Add to `session-service.test.mjs` an assertion that the `stub.init` options include `max_idle_time` (default `"10m"`) and `sandbox_provider`.

- [ ] **Step 2:** Run `pnpm --filter @codevil/shared test && pnpm --filter @codevil/worker test` → FAIL on the new assertions.
- [ ] **Step 3:** Implement the schema fields, `InitOptions.max_idle_time`, the two `stub.init` call sites, and `init` defaults. Check `SessionMetaSchema` is exported from shared's index (it is used by the worker; export it if not).
- [ ] **Step 4:** Rerun → PASS. Run `pnpm --filter @codevil/web test` too if web labels changed.
- [ ] **Step 5: Commit** — `git commit -m "feat(sandbox): add idle-pause session fields and paused sandbox state"`

---

### Task 4: E2B adapter, configuration, default provider

**Precondition:** Task 2 passed. Read its `## Feasibility Findings` first; if a finding contradicts this task (for example the traffic token is not repopulated on `connect`, or WebSockets need a different call), follow the finding and note the deviation in the commit message.

**Files:**
- Create: `packages/worker/src/sandbox-provider/e2b.ts`
- Modify: `packages/worker/src/sandbox-provider/index.ts`, `packages/worker/src/worker-env.ts`, `packages/worker/src/orchestrator.ts` (redaction secrets include the stored sandbox secret), `packages/worker/.dev.vars.example`, `packages/worker/wrangler.operator.example.toml`, `packages/worker/wrangler.toml` (`[vars] SANDBOX_PROVIDER = "e2b"`, `E2B_TEMPLATE_ID = "codevil-sandbox"`)
- Test: `packages/worker/test/sandbox-provider-e2b.test.mjs` (create), `packages/worker/test/redaction.test.mjs` or `logging-redaction.test.mjs` (extend)

**Interfaces:**
- Consumes: Task 1 types.
- Produces:

```ts
export interface E2BSdkSandbox {
  sandboxId: string;
  trafficAccessToken?: string;
  getHost(port: number): string;
  commands: { run(cmd: string, opts?: { background?: boolean; user?: string; cwd?: string; envs?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> };
  files: { write(path: string, content: string, opts?: { user?: string }): Promise<unknown> };
  setTimeout(ms: number): Promise<void>;
  pause(): Promise<unknown>;
  kill(): Promise<void>;
}
export interface E2BSdk {
  create(template: string, opts: { apiKey: string; timeoutMs: number; secure: true; allowPublicTraffic: false; metadata: Record<string, string> }): Promise<E2BSdkSandbox>;
  connect(sandboxId: string, opts: { apiKey: string; timeoutMs?: number }): Promise<E2BSdkSandbox>;
  isNotFound(error: unknown): boolean;
}
export function createE2BSandboxProvider(options: {
  apiKey: string; templateId: string; maxLeaseMs: number; sdk?: E2BSdk; fetch?: typeof fetch;
}): SandboxProvider;
export const E2B_TRAFFIC_TOKEN_HEADER = "e2b-traffic-access-token";
```

- `Env` gains `E2B_API_KEY?: string; E2B_TEMPLATE_ID?: string; E2B_MAX_SANDBOX_SECONDS?: string`. `WorkerSecretEnv` gains `E2B_API_KEY` and `collectWorkerSecretValues` includes it.
- `configuredSandboxProviderName` default flips to `"e2b"`.
- `resolveSandboxProvider(env, "e2b")` throws `Error("E2B_API_KEY is not configured")` when the key is missing; otherwise builds the provider with `templateId = env.E2B_TEMPLATE_ID || "codevil-sandbox"`, `maxLeaseMs = (Number(env.E2B_MAX_SANDBOX_SECONDS) || 3600) * 1000`.

Adapter behavior:

| Method | Implementation |
|---|---|
| `create({ sessionId, leaseMs })` | `sdk.create(templateId, { apiKey, timeoutMs: min(leaseMs, maxLeaseMs), secure: true, allowPublicTraffic: false, metadata: { codevil_session_id: sessionId } })`; `ref = { provider: "e2b", id: sandbox.sandboxId }`; `secret = sandbox.trafficAccessToken`. |
| `connect(ref, { leaseMs, secret })` | `sdk.connect(ref.id, { apiKey, timeoutMs: leaseMs && min(leaseMs, maxLeaseMs) })`; `secret` = argument ?? `sandbox.trafficAccessToken`. Not-found → `SandboxNotFoundError`. |
| `exec` | `commands.run(command, { cwd, envs: env, timeoutMs, user: user === "codevil" ? "codevil" : "root" })`; a thrown `CommandExitError` with `exitCode` maps to a `ShellResult` instead of throwing. |
| `writeFile(path, content, { mode, owner })` | `files.write(path, content, { user: "root" })`, then `exec("mkdir -p … ; chmod <mode octal> '<path>' && chown <10001:10001|0:0> '<path>'")`. Use `mode.toString(8)`. Shell-quote paths with single quotes. |
| `startProcess(command, { processId, cwd, env })` | `exec("mkdir -p /var/log/codevil")`; `commands.run(\`${command} >/var/log/codevil/${processId}.out 2>/var/log/codevil/${processId}.err\`, { background: true, user: "root", cwd, envs: env })`. Wrap the command as `sh -c '<escaped>'` so the redirection applies to the whole command. Validate `processId` with `/^[a-z0-9-]+$/`. |
| `readProcessLogs(id)` | two `exec("tail -c 65536 /var/log/codevil/<id>.out 2>/dev/null || true")` calls (`.out`, `.err`). |
| `readLifecycle` | absent. |
| `fetchPort(port, request)` | `url = new URL(request.url)`; target `https://${sandbox.getHost(port)}${url.pathname}${url.search}`; copy headers, set `e2b-traffic-access-token: secret`, delete `host`; `return fetchImpl(new Request(target, { method, headers, body, redirect: "manual" }))`. WebSocket upgrades pass through because `fetch` with `Upgrade: websocket` returns the 101 response with `.webSocket`. |
| `renewLease(ms)` | `sandbox.setTimeout(min(ms, maxLeaseMs))`. |
| `pause()` | `sandbox.pause()`. |
| `destroy()` | `sandbox.kill()`; not-found is success. |
| `capabilities` | `{ pauseResume: true, workspaceCache: false }`. |

The default `sdk` lazily imports `e2b` (`const { Sandbox, NotFoundError } = await import("e2b")`) so tests and Cloudflare-only paths never load it.

Orchestrator: when the stored `codevil:sandbox_secret` exists, add it to `this.redactionSecrets` (load it in the constructor's `blockConcurrencyWhile` or lazily in `sandboxHandle()` and push into a mutable secrets array).

- [ ] **Step 1: Failing tests** — `packages/worker/test/sandbox-provider-e2b.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createE2BSandboxProvider, E2B_TRAFFIC_TOKEN_HEADER } from "../dist/sandbox-provider/e2b.js";
import { SandboxNotFoundError } from "../dist/sandbox-provider/types.js";
import { collectWorkerSecretValues } from "../dist/worker-env.js";
import { configuredSandboxProviderName, resolveSandboxProvider } from "../dist/sandbox-provider/index.js";

class NotFound extends Error {}

function fakeSdk() {
  const log = [];
  const files = new Map();
  const sandbox = {
    sandboxId: "sbx_1",
    trafficAccessToken: "tat_secret",
    getHost: (port) => `${port}-sbx_1.e2b.app`,
    commands: {
      run: async (cmd, opts) => {
        log.push(["run", cmd, opts]);
        if (cmd.startsWith("tail -c 65536 /var/log/codevil/codevil-agent.out")) return { stdout: "agent out", stderr: "", exitCode: 0 };
        if (cmd.startsWith("tail -c 65536 /var/log/codevil/codevil-agent.err")) return { stdout: "agent err", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
    files: { write: async (path, content, opts) => { files.set(path, content); log.push(["write", path, opts]); } },
    setTimeout: async (ms) => { log.push(["setTimeout", ms]); },
    pause: async () => { log.push(["pause"]); },
    kill: async () => { log.push(["kill"]); },
  };
  const sdk = {
    create: async (template, opts) => { log.push(["create", template, opts]); return sandbox; },
    connect: async (id, opts) => {
      log.push(["connect", id, opts]);
      if (id === "gone") throw new NotFound("sandbox gone");
      return sandbox;
    },
    isNotFound: (error) => error instanceof NotFound,
  };
  return { sdk, log, files };
}

function provider(overrides = {}) {
  const fake = fakeSdk();
  const fetchCalls = [];
  const p = createE2BSandboxProvider({
    apiKey: "e2b_key", templateId: "codevil-sandbox", maxLeaseMs: 3_600_000, sdk: fake.sdk,
    fetch: async (request) => { fetchCalls.push(request); return new Response("preview"); },
    ...overrides,
  });
  return { p, fake, fetchCalls };
}

test("create locks public traffic, caps the lease, and returns the traffic token as the secret", async () => {
  const { p, fake } = provider();
  const handle = await p.create({ sessionId: "ses_1", leaseMs: 7_200_000 });
  assert.deepEqual(handle.ref, { provider: "e2b", id: "sbx_1" });
  assert.equal(handle.secret, "tat_secret");
  assert.deepEqual(fake.log[0], ["create", "codevil-sandbox", {
    apiKey: "e2b_key", timeoutMs: 3_600_000, secure: true, allowPublicTraffic: false,
    metadata: { codevil_session_id: "ses_1" },
  }]);
  assert.deepEqual(p.capabilities, { pauseResume: true, workspaceCache: false });
});

test("connect maps not-found to SandboxNotFoundError", async () => {
  const { p } = provider();
  await assert.rejects(p.connect({ provider: "e2b", id: "gone" }), SandboxNotFoundError);
});

test("fetchPort targets the E2B host with the traffic token and keeps path and query", async () => {
  const { p, fetchCalls } = provider();
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" }, { secret: "tat_secret" });
  await handle.fetchPort(5173, new Request("http://localhost/src/main.ts?t=1", { headers: { host: "localhost:5173", upgrade: "websocket" } }));
  assert.equal(fetchCalls[0].url, "https://5173-sbx_1.e2b.app/src/main.ts?t=1");
  assert.equal(fetchCalls[0].headers.get(E2B_TRAFFIC_TOKEN_HEADER), "tat_secret");
  assert.equal(fetchCalls[0].headers.get("upgrade"), "websocket");
});

test("startProcess redirects output to per-process log files and readProcessLogs tails them", async () => {
  const { p, fake } = provider();
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" });
  await handle.startProcess("node /app/x.js", { processId: "codevil-agent", cwd: "/workspace", env: { A: "1" } });
  const background = fake.log.find(([kind, , opts]) => kind === "run" && opts?.background);
  assert.match(background[1], />\/var\/log\/codevil\/codevil-agent\.out 2>\/var\/log\/codevil\/codevil-agent\.err/);
  assert.deepEqual(background[2], { background: true, user: "root", cwd: "/workspace", envs: { A: "1" } });
  assert.deepEqual(await handle.readProcessLogs("codevil-agent"), { stdout: "agent out", stderr: "agent err" });
  await assert.rejects(handle.startProcess("x", { processId: "../etc", cwd: "/", env: {} }));
});

test("writeFile sets mode and owner", async () => {
  const { p, fake } = provider();
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" });
  await handle.writeFile("/run/codevil/ws-token", "tok", { mode: 0o600, owner: "codevil" });
  assert.equal(fake.files.get("/run/codevil/ws-token"), "tok");
  const chmod = fake.log.find(([kind, cmd]) => kind === "run" && cmd.includes("chmod"));
  assert.match(chmod[1], /chmod 600 '\/run\/codevil\/ws-token' && chown 10001:10001 '\/run\/codevil\/ws-token'/);
});

test("renewLease caps at the provider maximum; pause and destroy delegate", async () => {
  const { p, fake } = provider();
  const handle = await p.connect({ provider: "e2b", id: "sbx_1" });
  await handle.renewLease(9_999_999);
  await handle.pause();
  await handle.destroy("done");
  assert.deepEqual(fake.log.slice(-3), [["setTimeout", 3_600_000], ["pause"], ["kill"]]);
});

test("E2B key is a redacted worker secret and e2b is the default provider", () => {
  assert.ok(collectWorkerSecretValues({ E2B_API_KEY: "e2b_key" }).includes("e2b_key"));
  assert.equal(configuredSandboxProviderName({}), "e2b");
  assert.throws(() => resolveSandboxProvider({ Sandbox: {} }, "e2b"), /E2B_API_KEY is not configured/);
});
```

Update the Task 1 test assertion `configuredSandboxProviderName({}) === "cloudflare"` to `"e2b"` in the same commit.

- [ ] **Step 2:** Run `pnpm --filter @codevil/worker test` → FAIL (module missing).
- [ ] **Step 3:** Implement `e2b.ts`, config, redaction, and the `wrangler.toml` / example env updates. In `.dev.vars.example` add:

```
# Sandbox provider (e2b | cloudflare). E2B is the default.
# SANDBOX_PROVIDER=e2b
E2B_API_KEY=
# E2B_TEMPLATE_ID=codevil-sandbox
# E2B_MAX_SANDBOX_SECONDS=3600
```

- [ ] **Step 4:** Add a redaction test: an `Error` whose message contains `tat_secret` and `e2b_key`, passed through the Orchestrator's error-logging path (`redactEvent(safeExceptionAttributes(error), secrets)` with secrets including both), contains neither string.
- [ ] **Step 5:** Run `pnpm --filter @codevil/worker typecheck && pnpm --filter @codevil/worker test` → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(sandbox): add E2B sandbox provider and make it the default"`

---

### Task 5: Agent rereads the WebSocket token file on reconnect

**Files:**
- Modify: `packages/sandbox-image/src/entrypoint.ts`
- Test: `packages/sandbox-image/test/runtime.test.mjs` or new `packages/sandbox-image/test/ws-token-file.test.mjs`

**Interfaces:**
- Produces: `export const SANDBOX_WS_TOKEN_FILE = "/run/codevil/ws-token"` and `export function currentSandboxWebSocketUrl(wsUrl: string, readToken: () => string | undefined): string` in `entrypoint.ts`.

- [ ] **Step 1: Failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { currentSandboxWebSocketUrl, SANDBOX_WS_TOKEN_FILE } from "../dist/entrypoint.js";

test("uses the token file when present", () => {
  const url = currentSandboxWebSocketUrl("wss://w/sessions/ses_1/sandbox/ws?sandbox_ws_token=old", () => "fresh\n");
  assert.equal(new URL(url).searchParams.get("sandbox_ws_token"), "fresh");
});

test("keeps the in-memory token when the file is missing or empty", () => {
  const base = "wss://w/sessions/ses_1/sandbox/ws?sandbox_ws_token=old";
  assert.equal(currentSandboxWebSocketUrl(base, () => undefined), base);
  assert.equal(currentSandboxWebSocketUrl(base, () => "  "), base);
});

test("token file path is fixed", () => {
  assert.equal(SANDBOX_WS_TOKEN_FILE, "/run/codevil/ws-token");
});
```

- [ ] **Step 2:** Run `pnpm --filter @codevil/sandbox-image test` → FAIL.
- [ ] **Step 3:** Implement:

```ts
export const SANDBOX_WS_TOKEN_FILE = "/run/codevil/ws-token";

export function currentSandboxWebSocketUrl(wsUrl: string, readToken: () => string | undefined): string {
  const token = readToken()?.trim();
  return token ? withSandboxWebSocketToken(wsUrl, token) : wsUrl;
}

function readTokenFile(): string | undefined {
  try { return readFileSync(SANDBOX_WS_TOKEN_FILE, "utf8"); } catch { return undefined; }
}
```

In `createSocket`, replace `new WebSocket(wsUrl)` with `wsUrl = currentSandboxWebSocketUrl(wsUrl, readTokenFile); return new WebSocket(wsUrl);` (keep the log line, logging `wsUrlForLog(wsUrl)`). Make sure importing `entrypoint.js` in tests has no side effects (it currently only exports; keep it that way).

- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sandbox-image): reread sandbox WebSocket token file on reconnect"`

---

### Task 6: Pure idle-pause and lease helpers + alarm deadlines

**Files:**
- Create: `packages/worker/src/orchestrator/sandbox-lifecycle.ts`
- Modify: `packages/worker/src/orchestrator/alarm.ts`
- Test: `packages/worker/test/sandbox-lifecycle.test.mjs` (create), `packages/worker/test/orchestrator-alarm.test.mjs` (extend)

**Interfaces:**
- Produces:

```ts
export const SANDBOX_LEASE_RENEW_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_MAX_IDLE_MS = 10 * 60_000;

export interface IdlePauseInput {
  now: number;
  pauseSupported: boolean;
  sessionState: SessionState;
  paused: boolean;
  sandboxConnected: boolean;
  disconnectedAt?: string;
  hasActiveRun: boolean;
  queuedRuns: number;
  openQuestions: number;
  lastActivityAt: string;
  maxIdleMs: number | null;
}
export function idlePauseDeadline(input: Pick<IdlePauseInput, "lastActivityAt" | "maxIdleMs">): number | null;
export function shouldPauseSandbox(input: IdlePauseInput): boolean;
export function sandboxLeaseMs(input: { now: number; createdAt: number; maxTimeMs: number | null; providerMaxMs: number }): number;
export function leaseRenewDeadline(input: { renewedAt?: string; createdAt: string }): number;
```

- `AlarmScheduleInput` gains `idlePauseAt?: number | null` and `leaseRenewAt?: number | null`; `nextAlarmDeadline` includes them when non-null and the state is not terminal.

Rules:
- `shouldPauseSandbox` is true only when `pauseSupported && !paused && sessionState === "ready" && sandboxConnected && !disconnectedAt && !hasActiveRun && queuedRuns === 0 && openQuestions === 0 && maxIdleMs !== null && now >= idlePauseDeadline(...)`.
- `idlePauseDeadline` = `Date.parse(lastActivityAt) + maxIdleMs`, or null when `maxIdleMs` is null.
- `sandboxLeaseMs` = `min(providerMaxMs, maxTimeMs === null ? providerMaxMs : max(60_000, createdAt + maxTimeMs - now))`.
- `leaseRenewDeadline` = `Date.parse(renewedAt ?? createdAt) + SANDBOX_LEASE_RENEW_INTERVAL_MS`.

- [ ] **Step 1: Failing tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldPauseSandbox, idlePauseDeadline, sandboxLeaseMs, leaseRenewDeadline, SANDBOX_LEASE_RENEW_INTERVAL_MS,
} from "../dist/orchestrator/sandbox-lifecycle.js";
import { nextAlarmDeadline } from "../dist/orchestrator/alarm.js";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const idle = (overrides = {}) => ({
  now: T0 + 10 * 60_000, pauseSupported: true, sessionState: "ready", paused: false, sandboxConnected: true,
  hasActiveRun: false, queuedRuns: 0, openQuestions: 0, lastActivityAt: "2026-10-01T00:00:00.000Z", maxIdleMs: 600_000,
  ...overrides,
});

test("pauses an idle, connected, ready sandbox at the idle deadline", () => {
  assert.equal(shouldPauseSandbox(idle()), true);
  assert.equal(shouldPauseSandbox(idle({ now: T0 + 599_999 })), false);
});

for (const [name, overrides] of [
  ["provider without pause", { pauseSupported: false }],
  ["already paused", { paused: true }],
  ["cloning", { sessionState: "cloning_repo" }],
  ["socket not attached", { sandboxConnected: false }],
  ["mid-reconnect", { disconnectedAt: "2026-10-01T00:09:00.000Z" }],
  ["active run", { hasActiveRun: true }],
  ["queued run", { queuedRuns: 1 }],
  ["open question", { openQuestions: 1 }],
  ["idle disabled", { maxIdleMs: null }],
]) {
  test(`never pauses when ${name}`, () => {
    assert.equal(shouldPauseSandbox(idle(overrides)), false);
  });
}

test("idle deadline follows the last activity", () => {
  assert.equal(idlePauseDeadline({ lastActivityAt: "2026-10-01T00:00:00.000Z", maxIdleMs: 600_000 }), T0 + 600_000);
  assert.equal(idlePauseDeadline({ lastActivityAt: "2026-10-01T00:00:00.000Z", maxIdleMs: null }), null);
});

test("lease is the shorter of remaining session time and the provider cap, at least one minute", () => {
  assert.equal(sandboxLeaseMs({ now: T0, createdAt: T0, maxTimeMs: 15 * 60_000, providerMaxMs: 3_600_000 }), 15 * 60_000);
  assert.equal(sandboxLeaseMs({ now: T0, createdAt: T0, maxTimeMs: 4 * 3_600_000, providerMaxMs: 3_600_000 }), 3_600_000);
  assert.equal(sandboxLeaseMs({ now: T0 + 15 * 60_000, createdAt: T0, maxTimeMs: 15 * 60_000, providerMaxMs: 3_600_000 }), 60_000);
  assert.equal(sandboxLeaseMs({ now: T0, createdAt: T0, maxTimeMs: null, providerMaxMs: 3_600_000 }), 3_600_000);
});

test("lease renewal deadline", () => {
  assert.equal(leaseRenewDeadline({ createdAt: "2026-10-01T00:00:00.000Z" }), T0 + SANDBOX_LEASE_RENEW_INTERVAL_MS);
});

test("alarm includes idle pause and lease renewal deadlines", () => {
  const base = { now: T0 + 120_000, state: "ready", createdAt: T0, maxTimeMs: null };
  assert.equal(nextAlarmDeadline({ ...base, idlePauseAt: T0 + 200_000, leaseRenewAt: T0 + 300_000 }), T0 + 200_000);
  assert.equal(nextAlarmDeadline({ ...base, idlePauseAt: null, leaseRenewAt: T0 + 300_000 }), T0 + 300_000);
  assert.equal(nextAlarmDeadline({ ...base, state: "failed", idlePauseAt: T0 + 200_000 }), undefined);
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm --filter @codevil/worker test` → PASS (existing alarm tests unchanged).
- [ ] **Step 5: Commit** — `git commit -m "feat(sandbox): add idle-pause and lease scheduling helpers"`

---

### Task 7: Orchestrator pause, resume, lease renewal, and teardown

**Files:**
- Create: `packages/worker/src/orchestrator/sandbox-resume.ts`
- Modify: `packages/worker/src/orchestrator.ts` (alarm, `armNextAlarm`, `fetchPreview`, `submitAgentRequest`, `terminateSandbox`, `handleStopSession`), `packages/worker/src/orchestrator/cli-handlers.ts` (`handleAgentRequest`), `packages/worker/src/orchestrator/host.ts`, `packages/worker/src/orchestrator/sandbox-handlers.ts` (provisioning uses `sandboxLeaseMs`; agent run finish records activity), `packages/worker/test/helpers/fake-host.mjs`
- Test: `packages/worker/test/sandbox-resume.test.mjs` (create)

**Interfaces:**
- Consumes: Task 1 `SandboxHandle`/`SandboxProvider`/`SandboxNotFoundError`; Task 3 meta fields; Task 6 helpers; Task 4 lease cap (`E2B_MAX_SANDBOX_SECONDS`) via a new `sandboxProviderMaxLeaseMs(env): number` exported from `sandbox-provider/index.ts` (Cloudflare: `Number.POSITIVE_INFINITY` clamp is not used because Cloudflare `renewLease` is a no-op; return `3_600_000`).
- Produces on `OrchestratorHost`: `recordActivity(): void`, `requestSandboxResume(): void`, `closeSandboxSockets(reason: string): void` (make the existing private method public), `issueSandboxWebSocketToken(): Promise<string>` (wrap the existing `issueSandboxWebSocketCapability(host)`).
- Produces in `sandbox-resume.ts`:

```ts
export const PREVIEW_RESUME_TIMEOUT_MS = 15_000;
export const RESUME_ATTEMPTS = 3;
export async function pauseIdleSandbox(host: OrchestratorHost, now: number): Promise<boolean>;
export function resumeSandbox(host: OrchestratorHost): Promise<void>;   // shares one in-flight promise per host
export async function renewSandboxLeaseIfDue(host: OrchestratorHost, now: number): Promise<void>;
export async function failLostSandbox(host: OrchestratorHost): Promise<void>; // "Sandbox expired."
```

Behavior:
- **`pauseIdleSandbox`**: build `IdlePauseInput` from meta (`openQuestions` = count of open rows in `questions` for the active run — 0 when no active run; `sandboxConnected = host.ctx.getWebSockets("sandbox").length > 0`; `maxIdleMs = parseMaxTimeMs(meta.max_idle_time ?? "10m")`). If `shouldPauseSandbox` → `meta.expected_close = true; saveMeta(); await handle.pause!(); meta.sandbox_paused_at = new Date(now).toISOString(); saveMeta(); host.closeSandboxSockets("sandbox paused"); host.updateDirectory({ sandbox_state: "paused" }); host.appendAndBroadcast({ type: "status", message: "Sandbox paused (idle)." })`. On pause error: `meta.expected_close = false; saveMeta();` log `sandbox.pause.failed` (redacted) and return false. `SandboxNotFoundError` → `failLostSandbox`.
- **`resumeSandbox`**: if `!meta.sandbox_paused_at` resolve immediately. Otherwise (single shared promise stored in a `WeakMap<OrchestratorHost, Promise<void>>`, cleared on settle): up to `RESUME_ATTEMPTS` tries of `provider.connect(ref, { leaseMs: sandboxLeaseMs(...), secret })`; then `await handle.writeFile("/run/codevil/ws-token", await host.issueSandboxWebSocketToken(), { mode: 0o600, owner: "codevil" })`; then `meta.sandbox_paused_at = undefined; meta.expected_close = false; meta.sandbox_lease_renewed_at = now; saveMeta(); updateDirectory({ sandbox_state: meta.state === "cloning_repo" ? "cloning" : "ready" }); appendAndBroadcast({ type: "status", message: "Sandbox resumed." })`. `SandboxNotFoundError` at any point → `failLostSandbox`. Exhausted retries → transition `failed`, cancel queued runs with `agent_run_failed` events (message `"Sandbox failed to resume."`), `updateDirectory({ room_state: "failed", sandbox_state: "failed" })`.
- **`renewSandboxLeaseIfDue`**: when not paused, ref set, state non-terminal, and `now >= leaseRenewDeadline(...)` → `handle.renewLease(sandboxLeaseMs(...))`, set `sandbox_lease_renewed_at`. Errors logged; `SandboxNotFoundError` → `failLostSandbox`.
- **`failLostSandbox`**: transition `failed`, fail the active run if any (`agent_run_failed` with `"Sandbox expired."`), broadcast `{ type: "error", message: "Sandbox expired." }`, `updateDirectory({ room_state: "failed", sandbox_state: "failed", active_run_state: activeRunId ? "failed" : null })`.
- **Activity**: `recordActivity()` sets `meta.last_activity_at = new Date().toISOString(); saveMeta()`. Called in `handleAgentRequest` (top, after the empty-text check), in `finishRunAndDrainQueue` / run completion paths (`agent-run-coordinator.ts`), and in `fetchPreview` for every request.
- **Resume triggers**: `handleAgentRequest` calls `host.requestSandboxResume()` when `meta.sandbox_paused_at` is set (the run is queued because no socket is attached — existing behavior — and drains on reconnect). `requestSandboxResume()` = `this.ctx.waitUntil(resumeSandbox(this).catch(log))`. `fetchPreview` awaits `Promise.race([resumeSandbox(this), timeout(PREVIEW_RESUME_TIMEOUT_MS)])` and returns `new Response("Sandbox is resuming. Retry shortly.", { status: 503, headers: { "Retry-After": "2" } })` on timeout, then proxies via `proxyPreviewRequest(request, meta, token, await this.sandboxHandle())`.
- **Alarm**: after the existing `max_time` / reconnect / provisioning checks and before `drainQueuedAgentWorkIfReady`, call `await renewSandboxLeaseIfDue(this, now)` then `await pauseIdleSandbox(this, now)`. `armNextAlarm` passes `idlePauseAt` (only when provider supports pause, not paused, state `ready`) and `leaseRenewAt` (only when not paused and ref set).
- **Teardown**: `terminateSandbox` already calls `handle.destroy(reason)` (Task 1); ensure it runs when paused too (do not short-circuit on `sandbox_paused_at`) and clears `sandbox_paused_at`. Add `terminateSandbox` to the generic `failed` paths that currently skip it: `failLostSandbox` does not call destroy for not-found; resume-exhausted failure calls `terminateSandbox("resume failed")`.
- **Reconnect mode**: no change to `sandboxConnectionMode`. Pause closes the DO's sandbox sockets with `expected_close = true`, so `webSocketClose` ignores the close and the resumed agent connects with `attachedSandboxCount === 0` → `"resume"` → `completeSandboxReconnect` + `drainQueuedAgentWorkIfReady`.

- [ ] **Step 1: Failing tests** — `packages/worker/test/sandbox-resume.test.mjs`. Extend `createFakeHost` with: `options.handle` (a fake handle recording `pause`, `writeFile`, `renewLease`, `destroy`), `options.provider` (`{ name: "e2b", capabilities: { pauseResume: true, workspaceCache: false }, connect }`), a `sandboxSockets` array returned by `ctx.getWebSockets("sandbox")`, `closeSandboxSockets` that empties it, and `issueSandboxWebSocketToken` returning `"fresh_token"`.

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeHost } from "./helpers/fake-host.mjs";
import { pauseIdleSandbox, resumeSandbox, renewSandboxLeaseIfDue } from "../dist/orchestrator/sandbox-resume.js";
import { SandboxNotFoundError } from "../dist/sandbox-provider/types.js";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const idleMeta = {
  state: "ready", sandbox_provider: "e2b", sandbox_ref: { provider: "e2b", id: "sbx_1" },
  max_idle_time: "10m", last_activity_at: "2026-10-01T00:00:00.000Z", created_at: "2026-10-01T00:00:00.000Z", max_time: "2h",
};

test("pauses after max_idle_time, closes sandbox sockets, and marks the sandbox paused", async () => {
  const { host, handle } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  assert.equal(await pauseIdleSandbox(host, T0 + 600_000), true);
  assert.deepEqual(handle.calls.map(([name]) => name), ["pause"]);
  assert.equal(host.meta.expected_close, true);
  assert.ok(host.meta.sandbox_paused_at);
  assert.equal(host.ctx.getWebSockets("sandbox").length, 0);
  assert.deepEqual(host.directoryPatches.at(-1), { sandbox_state: "paused" });
});

test("does not pause during an active run", async () => {
  const { host, handle } = createFakeHost({ ...idleMeta, active_run: { id: "run_1", state: "thinking" } }, { e2b: true, sandboxConnected: true });
  assert.equal(await pauseIdleSandbox(host, T0 + 3_600_000), false);
  assert.equal(handle.calls.length, 0);
});

test("a pause failure leaves the sandbox running and clears expected_close", async () => {
  const { host } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true, pauseError: new Error("boom") });
  assert.equal(await pauseIdleSandbox(host, T0 + 600_000), false);
  assert.equal(host.meta.expected_close, false);
  assert.equal(host.meta.sandbox_paused_at, undefined);
});

test("resume connects once for concurrent triggers and writes a fresh ws token", async () => {
  const { host, handle, provider } = createFakeHost({ ...idleMeta, sandbox_paused_at: "2026-10-01T00:10:00.000Z", expected_close: true }, { e2b: true });
  await Promise.all([resumeSandbox(host), resumeSandbox(host)]);
  assert.equal(provider.connectCalls, 1);
  assert.deepEqual(handle.calls.find(([name]) => name === "writeFile"), ["writeFile", "/run/codevil/ws-token", "fresh_token", { mode: 0o600, owner: "codevil" }]);
  assert.equal(host.meta.sandbox_paused_at, undefined);
  assert.equal(host.meta.expected_close, false);
});

test("resume of a vanished sandbox fails the session with Sandbox expired", async () => {
  const { host } = createFakeHost({ ...idleMeta, sandbox_paused_at: "2026-10-01T00:10:00.000Z" }, { e2b: true, connectError: new SandboxNotFoundError() });
  await resumeSandbox(host);
  assert.equal(host.meta.state, "failed");
  assert.ok(host.broadcasts.some((event) => event.type === "error" && event.message === "Sandbox expired."));
});

test("resume retries three times then fails and cancels queued runs", async () => {
  const queued = [{ id: "run_q", state: "queued", text: "t", actor: { id: "u", name: "U" }, created_at: "t" }];
  const { host, provider } = createFakeHost({ ...idleMeta, sandbox_paused_at: "x", queued_runs: queued }, { e2b: true, connectError: new Error("503") });
  await resumeSandbox(host);
  assert.equal(provider.connectCalls, 3);
  assert.equal(host.meta.state, "failed");
  assert.ok(host.broadcasts.some((event) => event.type === "agent_run_failed" && event.run_id === "run_q"));
});

test("lease renewal runs on schedule and not while paused", async () => {
  const { host, handle } = createFakeHost(idleMeta, { e2b: true, sandboxConnected: true });
  await renewSandboxLeaseIfDue(host, T0 + 5 * 60_000);
  assert.equal(handle.calls.filter(([name]) => name === "renewLease").length, 1);
  host.meta.sandbox_paused_at = "x";
  await renewSandboxLeaseIfDue(host, T0 + 20 * 60_000);
  assert.equal(handle.calls.filter(([name]) => name === "renewLease").length, 1);
});
```

Also add, in the same file, Orchestrator-level tests through existing harness patterns (see `sandbox-handlers.test.mjs` / `cli-handlers.test.mjs`) for:
- `handleAgentRequest` on a paused session queues the run and calls `requestSandboxResume` exactly once; `last_activity_at` updates.
- Max-time on a paused session calls `handle.destroy` (use the `terminateSandbox` path through the alarm; if the Orchestrator class is not instantiable in tests, extract the max-time branch into a helper in `sandbox-resume.ts` named `expireSessionAtMaxTime(host, now)` and test that).
- `sandboxConnectionMode("ready", undefined, 0) === "resume"` after a pause (guards Review Focus 3).

- [ ] **Step 2:** Run `pnpm --filter @codevil/worker test` → FAIL.
- [ ] **Step 3:** Implement `sandbox-resume.ts`, the host additions, and the Orchestrator wiring described above. Provisioning (`provisionSessionSandbox`) now computes `leaseMs` with `sandboxLeaseMs({ now, createdAt, maxTimeMs, providerMaxMs: sandboxProviderMaxLeaseMs(env) })` and sets `sandbox_lease_renewed_at` after create.
- [ ] **Step 4:** Run `pnpm --filter @codevil/worker typecheck && pnpm --filter @codevil/worker test` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(sandbox): pause idle E2B sandboxes and resume on demand"`

---

### Task 8: Shared sandbox image and E2B template publishing

**Precondition:** Task 2 findings name the template publishing command; use it.

**Files:**
- Modify: `Dockerfile.sandbox`, `packages/sandbox-image/package.json` (script `"e2b:template": "node scripts/e2b-template.mjs"`), `packages/sandbox-image/test/dockerfile.test.mjs`
- Create: `packages/sandbox-image/scripts/e2b-template.mjs`
- Modify docs: `README.md` deployment/config section (or the existing deployment doc that documents `wrangler.toml` vars) — document `SANDBOX_PROVIDER`, `E2B_API_KEY`, `E2B_TEMPLATE_ID`, `E2B_MAX_SANDBOX_SECONDS`, and `pnpm --filter @codevil/sandbox-image e2b:template`.

**Interfaces:**
- Produces: `Dockerfile.sandbox` with `ARG SANDBOX_BASE=docker.io/cloudflare/sandbox:0.12.7` and `FROM --platform=$CODEVIL_SANDBOX_PLATFORM ${SANDBOX_BASE}` for the runtime stage; template `codevil-sandbox` with 2 vCPU / 4096 MiB.

- [ ] **Step 1: Failing test** — extend `dockerfile.test.mjs`:

```js
test("runtime stage base is configurable and defaults to the Cloudflare sandbox image", () => {
  const dockerfile = readFileSync(new URL("../../../Dockerfile.sandbox", import.meta.url), "utf8");
  assert.match(dockerfile, /^ARG SANDBOX_BASE=docker\.io\/cloudflare\/sandbox:0\.12\.7$/m);
  assert.match(dockerfile, /^FROM --platform=\$CODEVIL_SANDBOX_PLATFORM \$\{SANDBOX_BASE\}$/m);
});

test("runtime stage installs bun when the base image lacks it", () => {
  const dockerfile = readFileSync(new URL("../../../Dockerfile.sandbox", import.meta.url), "utf8");
  assert.match(dockerfile, /command -v bun >\/dev\/null \|\| npm install -g bun/);
});

test("runtime stage prepares the agent log and token directories", () => {
  const dockerfile = readFileSync(new URL("../../../Dockerfile.sandbox", import.meta.url), "utf8");
  assert.match(dockerfile, /mkdir -p \/workspace \/var\/log\/codevil \/run\/codevil/);
});
```

(Match the existing test file's import style; it already reads the Dockerfile.)

- [ ] **Step 2:** Run `pnpm --filter @codevil/sandbox-image test` → FAIL.
- [ ] **Step 3:** Edit `Dockerfile.sandbox`: declare `ARG SANDBOX_BASE=docker.io/cloudflare/sandbox:0.12.7` at the top (before the first `FROM`), change the runtime `FROM` to use it, change the apt/npm `RUN` so it runs `command -v bun >/dev/null || npm install -g bun` before `bun --version`, and change the workspace `RUN` to `mkdir -p /workspace /var/log/codevil /run/codevil && chown codevil:codevil /workspace /run/codevil`. Keep every other line identical. Existing dockerfile tests must still pass.
- [ ] **Step 4:** Write `scripts/e2b-template.mjs` using the Task 2 command: build with `docker build --build-arg SANDBOX_BASE=node:22-slim -f Dockerfile.sandbox -t codevil-sandbox-e2b .` from the repo root, then publish as template `process.env.E2B_TEMPLATE_ID ?? "codevil-sandbox"` with `cpuCount: 2`, `memoryMB: 4096`. Exit non-zero with a clear message when `E2B_API_KEY` is missing. Print the template ID on success.
- [ ] **Step 5:** Run `pnpm --filter @codevil/sandbox-image test` → PASS. If `E2B_API_KEY` and Docker are available, run `pnpm --filter @codevil/sandbox-image e2b:template` and record the template ID in the commit message; otherwise state that it was not run.
- [ ] **Step 6: Commit** — `git commit -m "feat(sandbox-image): share Dockerfile across providers and publish E2B template"`

---

### Task 9: Full verification and manual end-to-end checklist

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-e2b-sandbox-provider-design.md` — append `## Verification Results`

- [ ] **Step 1:** Run `pnpm verify` from the repo root. Expected: typecheck and all package tests pass. Paste the summary lines into the spec section.
- [ ] **Step 2:** If `E2B_API_KEY` and a published template exist, run `pnpm --filter @codevil/worker dev` with `SANDBOX_PROVIDER=e2b` and walk the spec's manual checklist (create Session on a real repo → clone + `npm install`; preview with HMR; idle past `max_idle_time` (set `max_idle_time` to `2m` when creating the Session to save time) → paused; resume via prompt; pause again; resume via preview; stop Session → sandbox gone in the E2B dashboard). Record each step as pass/fail with notes. If credentials are not available, record "manual E2E not run — needs E2B_API_KEY + template" and do not claim it passed.
- [ ] **Step 3: Commit** — `git commit -m "docs(sandbox): record E2B provider verification results"`
