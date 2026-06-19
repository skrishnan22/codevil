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
- Document capacity limits, expected Cloudflare costs, and safe defaults for session cost/time/step limits.

### P1 — security

- Replace the shared GitHub PAT with a GitHub App installation flow and per-repository credentials.
- Document secret rotation and owner-account recovery.
- Add dependency, secret, and container-image scanning in CI.
- Review response security headers, CSP, OAuth redirect handling, rate limits, and abuse controls.

### P1 — self-hosting experience

- Add a Cloudflare Deploy button after the scripted deployment path is reliable.
- Add optional Resend configuration after the core path works without email.

## Release gate

A release is production-ready only when a clean Cloudflare account can follow the documented path without editing source files, all automated checks pass, a real session can create a pull request, and backup/restore plus rollback have been exercised.
