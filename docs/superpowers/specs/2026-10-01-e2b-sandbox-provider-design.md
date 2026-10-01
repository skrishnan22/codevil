# E2B Sandbox Provider Design

**Date:** 2026-10-01
**Status:** Approved

---

## Overview

Codevil runs every Session in a Cloudflare Sandbox container (`standard-1`: ½ vCPU, 4 GiB). In practice this causes three problems:

1. **CPU starvation.** `npm install`, dev servers, Pi, and workspace-cache `mksquashfs` (zstd, 4 threads) all share half a core. Installs and live preview stutter or fail.
2. **Unreliable workspace snapshots.** The R2 squashfs backup/restore path flakes (restore is retried up to four times) and never preserves running processes.
3. **Frequent disconnects** and a long preview path (Worker → Orchestrator DO → Sandbox DO → container, including HMR WebSockets).

This design introduces a provider-neutral sandbox interface, makes **E2B** the default provider, keeps Cloudflare as an opt-in adapter, and adds **pause-when-idle** on E2B using E2B's pause/resume (filesystem, memory, and running processes are preserved; resume takes about one second).

## Goals

- One `SandboxProvider` / `SandboxHandle` interface that the Orchestrator, preview, logs, and diagnostics use instead of calling `@cloudflare/sandbox` directly.
- An E2B adapter (default) and a Cloudflare adapter (opt-in) behind that interface.
- E2B sandboxes with 2 vCPU / 4 GiB, created from a Codevil template built from the shared Dockerfile.
- Pause the E2B sandbox after `max_idle_time` without agent input or preview traffic; resume transparently on the next Agent Request or preview request.
- Preview on E2B through the existing Codevil preview URLs and tokens, with E2B's public URLs locked behind a traffic access token.
- Preserve the existing security boundary: provider credentials, the GitHub PAT, and the E2B API key stay in the Worker; the sandbox receives only short-lived, audience-bound capabilities.

## Non-Goals

- A warm workspace cache on E2B. New E2B Sessions start cold (clone and install).
- Moving the Pi agent loop out of the sandbox.
- Fixing Cloudflare idle/keepalive behavior (keepalive is still only cleared by `terminateSandbox`).
- Removing `[[containers]]` or the `Sandbox` Durable Object from `wrangler.toml`.
- Per-Session provider choice in the UI or API.
- A Daytona or other third adapter (the interface allows one later).

## Background: Current Coupling

Direct `@cloudflare/sandbox` usage today:

| Concern | Location |
|---|---|
| Sandbox DO subclass, lifecycle hooks, keepalive deferral, WS port routing | `packages/worker/src/index.ts` |
| Provision + start agent process (`startProcess`), retries, keepalive | `packages/worker/src/sandbox.ts` |
| Logs and diagnostics (`getProcessLogs`, lifecycle snapshot) | `sandbox.ts`, `http-handlers.ts` (`handleLogs`, `handleDiagnostics`), `orchestrator.ts` (`logSandboxDisconnectDiagnostics`) |
| Stop (`setKeepAlive(false)` + `stop()`) | `orchestrator.ts` (`terminateSandbox`) |
| Preview proxy (`sandbox.fetch` with `cf-container-target-port`) | `orchestrator/preview.ts` |
| Workspace cache (`createBackup` / `restoreBackup`) | `workspace-cache.ts`, `orchestrator/workspace-cache-job.ts`, `orchestrator/sandbox-handlers.ts` |
| Image (`FROM cloudflare/sandbox:0.12.7`) | `Dockerfile.sandbox` |

The agent opens its own WebSocket back to the Orchestrator DO (`CODEVIL_DO_WS_URL` + `sandbox_ws_token`) and uses the Worker's LLM and Git proxies. That protocol does not depend on the provider.

## Architecture

### Provider interface

The shape follows Flue's sandbox adapter pattern (a factory per provider that returns a handle with a small `exec`/`ShellResult` core) and adds the lifecycle, background process, and port methods Codevil needs.

```ts
export type SandboxProviderName = "e2b" | "cloudflare";

export interface SandboxRef {
  provider: SandboxProviderName;
  /** E2B sandboxId; for Cloudflare, the Session ID (the Sandbox DO name). */
  id: string;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxProvider {
  readonly name: SandboxProviderName;
  readonly capabilities: {
    pauseResume: boolean;
    workspaceCache: boolean;
  };
  create(options: { sessionId: string; leaseMs: number }): Promise<SandboxHandle>;
  /** Attaches to an existing sandbox. Resumes it when paused. */
  connect(ref: SandboxRef, options?: { leaseMs?: number }): Promise<SandboxHandle>;
}

export interface SandboxHandle {
  readonly ref: SandboxRef;
  exec(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; user?: "root" | "codevil" },
  ): Promise<ShellResult>;
  writeFile(path: string, content: string, options?: { mode?: number; owner?: "root" | "codevil" }): Promise<void>;
  startProcess(
    command: string,
    options: { processId: string; cwd: string; env: Record<string, string> },
  ): Promise<void>;
  readProcessLogs(processId: string): Promise<{ stdout: string; stderr: string }>;
  /** Proxies an HTTP or WebSocket-upgrade request to a port inside the sandbox. */
  fetchPort(port: number, request: Request): Promise<Response>;
  renewLease(ms: number): Promise<void>;
  /** Present only when the provider's capabilities.pauseResume is true. */
  pause?(): Promise<void>;
  destroy(): Promise<void>;
}

export class SandboxNotFoundError extends Error {}
```

Module layout (worker package):

- `src/sandbox-provider/types.ts`: the interface, `SandboxNotFoundError`, and helpers.
- `src/sandbox-provider/index.ts`: `resolveSandboxProvider(env, name)` and `configuredSandboxProvider(env)`.
- `src/sandbox-provider/cloudflare.ts`: wraps today's code (`getCodevilSandbox`, keepalive, `startProcess`, `getProcessLogs`, `fetch` with `cf-container-target-port`, `stop`, `createBackup`/`restoreBackup`). `pause` is absent; `capabilities = { pauseResume: false, workspaceCache: true }`. `renewLease` is a no-op (Cloudflare uses keepalive).
- `src/sandbox-provider/e2b.ts`: the E2B adapter. `capabilities = { pauseResume: true, workspaceCache: false }`.

Workspace-cache code keeps its current types but is reached only through the Cloudflare adapter (the adapter exposes the `WorkspaceCacheSandbox` view when `capabilities.workspaceCache` is true). On E2B, cache restore and snapshot jobs are skipped.

### Provider selection and stored state

- `SANDBOX_PROVIDER` (`e2b` | `cloudflare`, default `e2b`) is read **once at Session creation** and stored as `meta.sandbox_provider`. Changing the variable affects only new Sessions.
- Sessions created before this change have no `sandbox_provider`; they are treated as `cloudflare`.
- After `create`, the Orchestrator stores `meta.sandbox_ref`. The E2B adapter also needs the traffic access token; the Orchestrator stores it in DO storage under its own key (never in `SessionMeta` broadcasts) and adds it to the Orchestrator's redaction secrets.
- `handleLogs` and `handleDiagnostics` are routed through the Orchestrator DO (an RPC on the stub), because only the Orchestrator knows the `SandboxRef`. Responses keep the existing redaction.

### Lifecycle

**Lease (E2B).** Sandboxes are created with E2B timeout `leaseMs = min(remaining max_time, E2B_MAX_SANDBOX_SECONDS × 1000)`. The Orchestrator alarm renews the lease while the sandbox runs. If the Orchestrator stops renewing, E2B kills the sandbox on its own.

**States.** `sandbox_state` gains `paused`. While paused, `meta.expected_close` is true, so the 60-second reconnect grace (`SANDBOX_RECONNECT_GRACE_MS`) does not apply and the Session is not failed.

**Activity.** The Orchestrator tracks `meta.last_activity_at`, updated on:

- a new Agent Request;
- an answer to an open question;
- an Agent Run finishing;
- any preview HTTP request.

An open preview WebSocket does not count as activity by itself.

**Pause.** On each alarm tick, when `capabilities.pauseResume` is true and all of the following hold:

- the sandbox is running and connected;
- no Agent Run is active or queued, and no question is open;
- `now − last_activity_at ≥ max_idle_time` (default `10m`);

the Orchestrator:

1. sets `meta.expected_close = true` and saves meta;
2. calls `handle.pause()`;
3. sets `sandbox_state = "paused"` (meta and session directory);
4. broadcasts a status "Sandbox paused (idle)."

The alarm is armed for the earlier of the idle deadline and existing deadlines.

**Resume.** Triggered by a new Agent Request or a preview request while `paused`:

1. `provider.connect(ref, { leaseMs })` resumes the sandbox.
2. The Orchestrator issues a fresh sandbox WebSocket capability and writes it to `/run/codevil/ws-token` (mode `0600`, owner `codevil`) with `handle.writeFile`.
3. `sandbox_state` becomes `connecting`; `expected_close` is cleared.
4. The agent's existing reconnect loop sees the dropped socket and reconnects with the new token. On connect it already requests fresh LLM and Git capabilities.

Concurrent resume triggers share one in-flight resume promise. Agent Requests queue as today until the sandbox WebSocket reconnects. A preview request waits for the resume for up to 15 seconds, then returns 503.

**Agent-side change.** `packages/sandbox-image/src/entrypoint.ts` reads `/run/codevil/ws-token` (when present and non-empty) in `createSocket` before each connection attempt and uses it in place of the in-memory token. When the file is absent (Cloudflare, or E2B before any resume), behavior is unchanged.

**Termination.** When a Session reaches a terminal state (`max_time`, user stop, failure), the Orchestrator calls `handle.destroy()` best-effort, whether the sandbox is running or paused. Paused E2B sandboxes never expire, so this is the only cleanup for them. `max_time` keeps counting from Session creation while paused.

**Cloudflare.** `pause` is absent, so the idle check never fires. Keepalive, `sleepAfter`, and lifecycle hooks in the `Sandbox` DO subclass stay unchanged.

### Preview

The request path on E2B is Browser → Worker → Orchestrator DO → `handle.fetchPort(port, request)` → `https://{port}-{sandboxId}.e2b.app`.

All existing preview logic stays in `orchestrator/preview.ts`: preview tokens and hashing, revocation, `validatePreviewAccess`, `rewriteHeadersForSandboxDevServer`, path-based body rewriting, and 502/503/504 retries. Only the final `sandbox.fetch` call is replaced by `handle.fetchPort`.

E2B sandboxes are created with `network: { allowPublicTraffic: false }` (the `secure` option is deprecated and ignored in e2b 2.x, and `allowPublicTraffic` is only honored under `network`; see Feasibility Findings). The E2B adapter's `fetchPort` adds the `e2b-traffic-access-token` header and forwards WebSocket upgrades with an outbound `fetch` carrying `Upgrade: websocket`, returning the 101 response.

### Image and template

- `Dockerfile.sandbox` gains `ARG SANDBOX_BASE=docker.io/cloudflare/sandbox:0.12.7`. The E2B build passes `node:22-slim`. The runtime stage installs `bun` when it is missing. Everything else (apt packages, the `codevil` user with UID/GID 10001, `/workspace`, the built `sandbox-image` app, Pi skills) is shared.
- `packages/sandbox-image` gains an `e2b:template` script that builds the image with local Docker and publishes it as E2B template `codevil-sandbox` with 2 vCPU / 4096 MiB. The publishing route, chosen in the feasibility gate, is `docker build` of the multi-stage `Dockerfile.sandbox`, push to a registry, then `Template.build(Template().fromImage(<registry image>, credentials), "codevil-sandbox", { cpuCount: 2, memoryMB: 4096 })`, because the SDK's `fromDockerfile` rejects multi-stage Dockerfiles (see Feasibility Findings, answer 7). Registry credentials for `fromImage` come from environment variables at template-build time and are never committed or placed in wrangler config.
- `dockerfile.test.mjs` covers both base variants.

### Agent process and logs (E2B)

- `startProcess` runs today's command (`chown` + `setpriv` to UID 10001, then `node /app/packages/sandbox-image/dist/index.js`) as root with `commands.run(..., { background: true, user: "root", cwd, envs })`.
- Output is redirected to `/var/log/codevil/<processId>.out` and `/var/log/codevil/<processId>.err`, because E2B streams output only while a client is attached.
- `readProcessLogs` returns the last 64 KiB of each file via `exec`. The existing redaction and disconnect-diagnostics payloads are unchanged.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `SANDBOX_PROVIDER` | `e2b` | Read at Session creation. |
| `E2B_API_KEY` | none (secret) | Stays in the Worker; added to redaction secrets. Provisioning fails with a clear error when missing. |
| `E2B_TEMPLATE_ID` | `codevil-sandbox` | Template name or ID. |
| `E2B_MAX_SANDBOX_SECONDS` | `3600` | Lease cap (matches the E2B Hobby session limit). |

`.dev.vars.example`, `wrangler.operator.example.toml`, and deployment docs document the new variables.

## Error Handling (E2B)

| Failure | Behavior |
|---|---|
| `create` fails | Retry 429, 5xx, and network errors with `retrySandboxOperation`; then fail the Session as today. |
| `SandboxNotFoundError` on connect, renew, or resume | The sandbox is gone. Fail the Session with "Sandbox expired." Never recreate silently. |
| Resume fails (other errors) | Retry three times, then fail the Session and cancel queued Agent Requests with that reason. |
| Pause fails | Log, leave the sandbox running, retry on the next alarm tick. |
| Lease renewal fails | Log, retry on the next tick. `SandboxNotFoundError` is handled as above. |
| Unexpected disconnect while running | Existing 60-second grace, then diagnostics through the handle. |
| Destroy fails at termination | Log only. The lease covers running sandboxes; paused leftovers are visible in the E2B dashboard. |

E2B error messages pass through `redactEvent` before logging, like Cloudflare errors today.

## Feasibility Gate

The feasibility gate is a throwaway probe that runs after the provider-neutral refactor (which does not depend on E2B and is reused by any fallback provider). No E2B-specific task starts until it passes. It runs in `wrangler dev` with `nodejs_compat` and a real `E2B_API_KEY`, and answers:

1. Does the E2B JS SDK run in workerd for create, `commands.run` (foreground and background), file write and read, `pause`, `connect` (resume), `setTimeout`, and `kill`?
2. Does a Worker `fetch` to `https://{port}-{sandboxId}.e2b.app` with `e2b-traffic-access-token` work for HTTP and for a WebSocket upgrade?
3. Does resuming a paused sandbox reset the Hobby one-hour session clock?
4. Which tool publishes a template from our multi-stage Dockerfile?

If (1) fails, implementation stops and the design is revisited (a Node control service or E2B's REST API are the fallbacks). Answers to (2)–(4) are recorded in this spec before any E2B-specific task starts.

## Testing

- **Cloudflare adapter:** a behavior-preserving refactor. Existing worker tests keep their assertions.
- **E2B adapter:** unit tests with a mocked E2B client covering create options (`network: { allowPublicTraffic: false }`, timeout), the access-token header and WebSocket forwarding in `fetchPort`, log file tails, `writeFile` mode and owner, and mapping not-found errors to `SandboxNotFoundError`.
- **Orchestrator** (fake host and fake provider):
  - idle pause fires after `max_idle_time` without input;
  - an active or queued run, or an open question, blocks pause;
  - preview requests delay pause;
  - an Agent Request and a preview request each resume and write a fresh token;
  - concurrent resume triggers share one resume;
  - `max_time` destroys a paused sandbox;
  - the stored `sandbox_provider` wins over a changed env var;
  - legacy Sessions without `sandbox_provider` use Cloudflare;
  - workspace-cache restore and jobs are skipped on E2B.
- **Entrypoint:** rereads `/run/codevil/ws-token` on reconnect; works unchanged without the file.
- **Manual end-to-end on E2B (free credits):**
  1. Create a Session on a real repo; clone and `npm install` complete.
  2. Start preview; hot reload works through the Codevil preview URL.
  3. Idle past `max_idle_time`; the sandbox pauses.
  4. Resume once with a prompt and once by opening the preview; the dev server is still running and the agent continues.
  5. Stop the Session; the sandbox is destroyed in the E2B dashboard.

## Feasibility Findings

Probe run on 2026-10-01 under `wrangler dev` 4.100.0 (workerd, `compatibility_date = "2026-04-07"`, `nodejs_compat`) with `e2b` **2.51.0** (`^2.51.0` in `packages/worker/package.json`). The probe Worker was throwaway and is not committed. Secrets are never recorded; only booleans, lengths and status codes.

**Gate: PASSED.** The SDK bundles and runs in workerd with no polyfill and no alternate import path (`import { Sandbox } from "e2b"`). Steps 1-3 succeeded.

### Answers

1. **SDK in workerd:** Yes. `Sandbox.create`, `commands.run`, `files.write`, `pause`, `connect`, `setTimeout`, `getInfo`, `kill` and `Sandbox.list` all worked. `create` took ~0.5-1.4s.
2. **WebSocket upgrade through `getHost(port)` with token:** Yes. A Worker `fetch("https://" + sandbox.getHost(8001) + "/", { headers: { Upgrade: "websocket", "e2b-traffic-access-token": token } })` returned `status 101` with `response.webSocket` non-null. After `ws.accept()`, a sent `ping` came back as `echo:ping`. Without the token header the upgrade returns 403. (Echo server: a ~25-line stdlib `python3` script; `websockets`/`wscat` were not needed.)
3. **Option-name correction (important for Task 4):** In e2b 2.51.0 `secure` is deprecated and ignored (every sandbox secures envd). `allowPublicTraffic` is **not** a top-level create option; it lives under `network`: `Sandbox.create({ network: { allowPublicTraffic: false } })`. With the plan's original options (`secure: true, allowPublicTraffic: false` top-level) the sandbox was created with public traffic allowed: `trafficAccessToken` was absent and requests with and without the header both returned 200 (and the WS upgrade succeeded without a token). With `network: { allowPublicTraffic: false }`, `trafficAccessToken` is present (64 chars), the HTTP request with the token returns 200 and without it 403.
4. **`Sandbox.connect` repopulates `trafficAccessToken`:** Yes. After `pause()` then `Sandbox.connect(id, { apiKey, timeoutMs })`, the connected instance had `trafficAccessToken` present (64 chars) and it equals the one from `create`. The background `python3 -m http.server` from before the pause still answered 200 after resume, and `/tmp/x` survived. Pause took ~0.5s, resume ~0.4s.
5. **Hobby 1-hour clock after resume:** Docs (https://docs.e2b.dev/sandbox/persistence): continuous runtime max is 1 hour on Hobby (24 hours on Pro), and "the continuous runtime limit is reset" after pause then resume. Observed: after `connect`, `getInfo().startedAt` was reset to the resume time and `endAt = startedAt + timeoutMs`. Record: **resets** (each resume starts a fresh clock). The SDK doc for `timeoutMs` also states max 1h Hobby / 24h Pro. Do not request a `timeoutMs` above 3_600_000 on Hobby.
6. **Killed sandbox:** `Sandbox.connect(killedId)` throws class `SandboxNotFoundError` (message "Paused sandbox <id> not found"), which `extends NotFoundError extends SandboxError`. Import both from the SDK with `import { Sandbox, NotFoundError } from "e2b"` (`SandboxNotFoundError` is also exported) and catch `NotFoundError` (instanceof) to cover both; do not match on the literal class name `NotFoundError`.
7. **Template publishing:**
   - The v2 Template SDK `Template().fromDockerfile(pathOrContent)` **rejects multi-stage Dockerfiles**: the converter throws `"Multi-stage Dockerfiles are not supported"` when a Dockerfile has more than one `FROM` (verified in `e2b/dist/index.mjs`). It also requires exactly one `FROM`.
   - `Template().fromImage('registry/image:tag', { username, password })` accepts any registry image (also `fromTemplate`, and an ECR variant), so a multi-stage Dockerfile must be built and pushed with Docker first, then referenced via `fromImage`. Build with `Template.build(template, 'name', { cpuCount, memoryMB, onBuildLogs })`.
   - CLI (`@e2b/cli` 2.21.0): `e2b template create <name> -d <Dockerfile> -p <dir> [-c <start-cmd>] [--ready-cmd <cmd>] [--cpu-count N] [--memory-mb N]` "builds a Dockerfile as a sandbox template". `e2b template migrate` converts `e2b.Dockerfile`/`e2b.toml` to the SDK format; `e2b template publish` only makes an existing template public (it is not the build step). Multi-stage support in the CLI path was not verified (no template was built); assume unsupported and use the `fromImage` route. Not published, per instructions.
   - Recommended command for Task 8: `docker build` + `docker push` the multi-stage image, then a small script calling `Template.build(Template().fromImage('<registry>/<image>:<tag>', creds), '<template-name>')`. The registry credentials (`creds`) are read from environment variables at template-build time and are never committed or placed in wrangler config.

### Probe results (redacted JSON)

Run 1 (original plan options, `secure: true, allowPublicTraffic: false`; sandbox `idbq4u63mdmmsc6p3bbga`, killed):

```json
{
  "step1_create": { "ok": true, "ms": 1444, "trafficAccessTokenPresent": false },
  "step2_echo": { "ok": true, "stdout": "hi\n", "exitCode": 0 },
  "step3_files": { "ok": true, "stdout": "y" },
  "step4_http": { "ok": false, "withTokenStatus": 200, "withoutTokenStatus": 200 },
  "step5_ws": { "status": 101, "webSocketNonNull": true, "echo": "echo:ping", "withoutTokenStatus": 101 },
  "step6_pause_resume": { "pauseMs": 517, "resumeMs": 351, "connectedTrafficAccessTokenPresent": false, "backgroundServerStatusAfterResume": 200, "fileSurvives": true },
  "step7_connectKilled": { "class": "SandboxNotFoundError" }
}
```

Run 2 (`network: { allowPublicTraffic: false }`; sandbox `ipv0doc3yywqgunnnhbva`, killed):

```json
{
  "step1_create": { "ok": true, "ms": 475, "trafficAccessTokenPresent": true, "trafficAccessTokenLength": 64 },
  "step2_echo": { "ok": true, "stdout": "hi\n", "exitCode": 0 },
  "step3_files": { "ok": true, "stdout": "y" },
  "step4_http": { "ok": true, "withTokenStatus": 200, "withoutTokenStatus": 403, "hostShape": "8000-<id>.e2b.app" },
  "step5_ws": { "ok": true, "status": 101, "webSocketNonNull": true, "echo": "echo:ping", "withoutTokenStatus": 403 },
  "step6_pause_resume": {
    "pauseMs": 516, "resumeMs": 418,
    "connectedTrafficAccessTokenPresent": true, "connectedTrafficAccessTokenLength": 64, "sameTokenAsCreate": true,
    "backgroundServerStatusAfterResume": 200, "fileSurvives": true,
    "startedAtAfterConnect": "2026-10-01T17:26:37Z (reset to resume time)", "endAtAfterConnect": "startedAt + 300s"
  },
  "step7_timeout": { "ok": true, "setTimeout120sApplied": true },
  "step7_connectKilled": { "class": "SandboxNotFoundError", "message": "Paused sandbox <id> not found" }
}
```

A final `Sandbox.list` for the key returned 0 running sandboxes.
