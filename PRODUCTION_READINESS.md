# Production readiness

The target self-hosting contract is:

1. Clone and install.
2. Supply only credentials that cannot be generated locally: Google OAuth, GitHub, and an LLM provider.
3. Run one deployment command.
4. Open the URL and claim the first owner account.

Cloudflare-specific resource IDs, domains, CORS origins, frontend API URLs, and SSH keys must not be required inputs.

## Current baseline

- The Worker, SPA, Durable Objects, container, and auto-provisioned D1 binding are described by one generic Wrangler configuration.
- The SPA and API use one origin.
- Account-specific domains, OAuth IDs, D1 IDs, and SSH keys have been removed from source control.
- Runtime secret names are documented in `.env.example`.
- `pnpm verify` is the local quality gate.
- `pnpm deploy` builds the production SPA and deploys the Worker bundle.
- `pnpm providers` interactively attempts to validate selected provider credentials and uploads accepted values directly as deployment-wide Worker secrets; if validation is unavailable, the operator must explicitly retry, skip validation, or cancel.
- Provider configuration is rerunnable for key rotation and does not persist provider keys in D1 or project files.
- `CODEVIL_LLM_KEY` remains a Worker runtime compatibility fallback, but is not part of the setup contract for new installations.

## Remaining release blockers

### P0 — repeatable first deployment

- Add a preflight/doctor command that checks Wrangler authentication, Containers access, Docker, required credentials, and Google OAuth callback configuration before deployment.
- Generate `CODEVIL_API_KEY`, `CODEVIL_SETUP_TOKEN`, and `BETTER_AUTH_SECRET` automatically; users should only paste external credentials.
- Add an authenticated deployment smoke test covering sign-in configuration, D1 schema state, session creation, WebSocket upgrade, and sandbox startup.
- Make first-deploy and upgrade migration ordering explicit. An upgrade must not deploy code that requires a schema migration before that migration is safely applied.

### P0 — CI and releases

- Run `pnpm verify`, the production web build, and Wrangler configuration validation on every pull request.
- Build the sandbox image in CI so missing Docker or image regressions fail before release.
- Publish immutable version tags and a changelog; document supported upgrade paths and rollback steps.
- Pin production container and critical runtime dependencies to reviewed versions or digests.

### P0 — operations

- Document D1 backup, restore, and migration recovery procedures and test a restore.
- Define health and readiness endpoints that distinguish Worker, D1, auth configuration, and sandbox availability.
- Add alerts for Worker errors, failed sandbox starts, exhausted container capacity, authentication failures, and abnormal spend.
- Document capacity limits, expected Cloudflare costs, and safe defaults for session cost/time/step limits. Cost-optimization levers are collected below under "Cost optimization".

### P1 — security

- Replace the shared GitHub PAT with a GitHub App installation flow and per-repository credentials.
- Document secret rotation and owner-account recovery.
- Add dependency, secret, and container-image scanning in CI.
- Review response security headers, CSP, OAuth redirect handling, rate limits, and abuse controls.

### P1 — self-hosting experience

- Add a Cloudflare Deploy button after the scripted deployment path is reliable.
- Add optional Resend configuration after the core path works without email.

## Cost optimization

Infra-layer levers for one self-hosted Cloudflare deployment, ordered by expected
impact. Config locations are relative to the repository root; the largest single
variable cost (LLM inference) is listed at the end for completeness.

### Where the bill comes from today

| Resource | Config | Billing unit | Current setting |
| --- | --- | --- | --- |
| Sandbox **Containers** | `packages/worker/wrangler.toml` → `[[containers]]` | vCPU-seconds, GiB-seconds, disk while an instance runs | `instance_type = "standard-3"`, `max_instances = 5`, `sleepAfter = "10m"` override in `packages/worker/src/index.ts`, `keepAlive = true` in `packages/worker/src/sandbox.ts` |
| **Durable Objects** | `wrangler.toml` → `[[durable_objects.bindings]]` | requests, wall-clock duration, SQLite storage | hibernatable WebSockets already used (`acceptWebSocket` + `serializeAttachment` in `orchestrator.ts`); snapshot append debounced and capped (`orchestrator/event-log-limits.ts`) |
| **D1** | `wrangler.toml` → `[[d1_databases]]` | rows read/written, storage | sessions/events accumulate; no retention or archival |
| **R2** | `wrangler.toml` → `[[r2_buckets]]` | storage + Class A/B operations | per-session workspace backups, zstd, 30-day TTL (`src/workspace-cache.ts`) |
| **Observability** | `wrangler.toml` → `[observability]` + `[observability.traces]` | Workers Logs + trace ingestion | `head_sampling_rate = 1` (100% of routed requests logged and traced) |
| **Worker + assets** | `wrangler.toml` → `[assets]` | Worker requests + CPU time | `run_worker_first = true`: every static asset fetch is a Worker invocation |
| **CI** | `.github/workflows/ci.yml` | Actions minutes + container image builds | `pnpm verify` plus a full `Dockerfile.sandbox` build on every PR |

### Levers

1. **Enforce the guards already in schema.** `max_time` is enforced by the
   orchestrator alarm (default `30m`, `packages/shared/src/config.ts`), but
   `max_idle_time` (default `10m`, `session-directory.ts`) is persisted and never
   enforced, and `max_cost`/`max_steps` are legacy schema-compat columns only
   (`legacyDirectoryGuardColumns()`). Enforcing them in the orchestrator alarm
   path bounds worst-case container + LLM spend per session — highest impact per
   unit of effort.
2. **Containers: right-size and sleep faster.** `standard-3` is the largest
   instance type configured. Measure peak RSS/CPU for a realistic session before
   dropping to `standard-2`/`standard-1` (undersizing lengthens runs and can
   raise LLM spend). Lower `sleepAfter` from `10m` to ~2–5m so idle instances
   stop accruing CPU/memory. Keep `max_instances = 5` as the hard concurrency
   cap, use a smaller cap for staging, and clear the keep-alive flag (currently
   `shouldDeferSandboxActivityExpiry` in `src/sandbox.ts`) when a run blocks on
   a question or reaches terminal state — not just on timeout.
3. **Stop billing every asset fetch as a Worker request.** With
   `run_worker_first = true` the SPA is only reachable through the Worker
   script. If wrangler 4.x supports path-scoped `run_worker_first`, restrict it
   to `/api/*`, `/sessions/*`, and WebSocket routes; alternatively serve the SPA
   from Pages (the deployment already tolerates a separate `CODEVIL_WEB_ORIGIN`,
   e.g. `codevil-ui.pages.dev`) so static traffic never invokes the Worker.
4. **Right-size observability sampling.** Drop `head_sampling_rate` to ~0.1 on
   logs and traces while keeping error paths sampled unconditionally. High-value
   events (sandbox lifecycle, keep-alive) are logged per event today.
5. **Retention for D1 and R2.** Add session archival/expiry so old event logs
   stop growing D1 storage and read rows. Shorten the workspace-backup TTL from
   30 days (`WORKSPACE_CACHE_TTL_SECONDS`), back up at run end instead of on
   churn, and add an R2 lifecycle rule.
6. **Sandbox image and workspace cache.** Trim unused tooling from
   `Dockerfile.sandbox` (smaller pull, faster cold start, less disk billing).
   The zstd workspace cache already avoids re-clone/re-install per session —
   more cache hits mean shorter active container time.
7. **LLM (adjacent, usually the largest line).** `deepseek-v4-flash` is already
   the default for plan and exec. Remaining levers: keep flash for planning and
   escalate exec only when warranted, enable prompt caching, truncate tool
   output, and compact context.

### Recommended sequence

1. Measure for two weeks with the existing 100% sampling to get a per-resource
   spend picture before changing anything.
2. Enforce `max_idle_time`, `max_cost`, and `max_steps`.
3. Right-size the container, lower `sleepAfter`, scope keep-alive to active runs.
4. Path-scope `run_worker_first` or move the SPA to Pages.
5. Add D1/R2 retention and end-of-run backups.
6. Lower observability sampling.
7. Re-measure, set abnormal-spend alerts, and evaluate a prepaid commitment once
   usage is stable.

## Release gate

A release is production-ready only when a clean Cloudflare account can follow the documented path without editing source files, all automated checks pass, a real session can create a pull request, and backup/restore plus rollback have been exercised.
