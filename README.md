# Codevil

[![CI](https://github.com/skrishnan22/codevil/actions/workflows/ci.yml/badge.svg)](https://github.com/skrishnan22/codevil/actions/workflows/ci.yml)

Codevil is a self-hosted AI coding agent platform. Each coding session runs in an isolated sandbox (an E2B sandbox or a Cloudflare Sandbox container, selectable per deployment) and streams its progress to a collaborative web UI.

## Self-hosting

Prerequisites: Node.js 20+, pnpm 10, a Cloudflare account (with Workers Containers access for the Cloudflare sandbox provider), an E2B account and API key if you use the E2B provider, a Google OAuth client, at least one supported provider API key, and a fine-grained GitHub token.

Install dependencies, authenticate Wrangler, and prepare the auth, GitHub, and bootstrap secrets:

```sh
pnpm install
pnpm exec wrangler login
cp packages/worker/.env.example packages/worker/.env.production
```

Set `GITHUB_PAT`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in `packages/worker/.env.production`. Generate independent random values for `CODEVIL_API_KEY`, `CODEVIL_SETUP_TOKEN`, `CODEVIL_PROXY_SIGNING_SECRET`, and `BETTER_AUTH_SECRET` by running this command separately for each secret and pasting a different result each time:

```sh
openssl rand -hex 32
```

Replace every `REPLACE_ME` placeholder before upload. Never upload the example placeholders unchanged. Add `E2B_API_KEY` to the file as well if you will run sessions on E2B (see [Sandbox provider](#sandbox-provider)); leave it out for Cloudflare-only deployments. Once all values are set, upload the file through Wrangler's existing bootstrap path:

```sh
cd packages/worker
pnpm exec wrangler secret bulk .env.production
```

Apply the remote D1 migrations, then deploy the Worker:

```sh
cd ../..
cd packages/worker
pnpm exec wrangler d1 migrations apply DB --remote
cd ../..
pnpm deploy
```

Wrangler creates and binds the D1 database automatically. The Worker, web UI, Durable Objects, and sandbox container ship as one deployment. Return to the repository root and configure one or more LLM providers:

```sh
cd ../..
pnpm providers
```

`pnpm providers` uses hidden TTY prompts and attempts to validate every selected provider credential before uploading it directly as a deployment-wide Cloudflare Worker secret. If validation is unavailable, the operator must explicitly retry, skip validation, or cancel. The command accepts no secret flags and can be rerun to add providers or rotate keys. Provider keys are not stored in D1 or project files.

For the GitHub Actions production deploy, set the protected `production` environment variable `CODEVIL_WEB_ORIGIN` to the HTTPS origin serving the web UI (for this deployment, `https://codevil-ui.pages.dev`). The deployment fails closed if it is empty or malformed, preventing credentialed browser requests from silently receiving an unusable wildcard CORS response.

In the Google OAuth client, add the deployed Worker origin as an authorized JavaScript origin and add `<worker-origin>/api/auth/callback/google` as an authorized redirect URI. Google OAuth is required even if GitHub is configured.

Open the Worker URL, sign in with Google, claim the first owner account using `CODEVIL_SETUP_TOKEN`, and invite the rest of the team.

## Sandbox provider

Codevil runs each session in either an E2B sandbox or a Cloudflare Sandbox container. The shipped `wrangler.toml` pins `SANDBOX_PROVIDER = "cloudflare"` so a deploy never switches to E2B before it is ready. To move to E2B: (1) add `E2B_API_KEY` both as a Worker secret and as a GitHub Actions secret in the `production` environment, (2) pass the manual end-to-end check, (3) set `SANDBOX_PROVIDER = "e2b"` and merge to `main`. CI then publishes the template on every deploy (see below). The Worker's code default (no var set) is `e2b`. Configure the provider with Worker vars in `packages/worker/wrangler.toml` (or an untracked `wrangler.operator.toml` overlay):

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `SANDBOX_PROVIDER` | var | `e2b` in code; `cloudflare` in the shipped `wrangler.toml` | `e2b` or `cloudflare`. |
| `E2B_API_KEY` | secret | none | Required when `SANDBOX_PROVIDER=e2b`. Upload with `pnpm exec wrangler secret put E2B_API_KEY`; never put it in `wrangler.toml`. |
| `E2B_TEMPLATE_ID` | var | `codevil-sandbox` | E2B template the sandboxes start from, without a tag. CI deploys pin it to `<template>:<commit sha>`. |
| `E2B_MAX_SANDBOX_SECONDS` | var | `3600` | Maximum continuous sandbox runtime; the default matches the E2B Hobby limit. |

### Publishing the E2B template

On a CI deploy this is automatic, the same way `wrangler deploy` builds the Cloudflare container image. When `wrangler.toml` sets `SANDBOX_PROVIDER = "e2b"`, the `e2b-template` job builds this commit's sandbox image, pushes it to `ghcr.io/<owner, lowercased>/codevil-sandbox:<commit sha>` with the workflow's `GITHUB_TOKEN`, and publishes it as the E2B template tagged with the commit SHA (and `default`, so the untagged name follows the latest publish). Only then does the `deploy` job ship the Worker pinned to `E2B_TEMPLATE_ID = "<template>:<commit sha>"`; a failed publish stops the deploy. With `SANDBOX_PROVIDER = "cloudflare"` the publish is skipped and E2B is never called. The deploy config must set `SANDBOX_PROVIDER` explicitly in `[vars]`.

The first CI push creates the GHCR package and links it to the repository. If you already created `codevil-sandbox` by hand, CI's push is refused until you grant access: in the package settings, under **Manage Actions access**, add this repository with the **Write** role.

To publish by hand (an operator deploy without CI, or a first manual test), run the script below. Both providers share `Dockerfile.sandbox`. The Cloudflare build uses its default `cloudflare/sandbox` base; the E2B template is built from the same file on a plain `node:22-slim` base. E2B's Template SDK cannot read multi-stage Dockerfiles, so the publish script builds the image with local Docker (the Dockerfile pins `linux/amd64`, which E2B runs, also on Apple Silicon), pushes it to a registry, and then registers the pushed image as an E2B template with 2 vCPU / 4096 MiB:

```sh
export E2B_API_KEY=...                                   # E2B account key
export CODEVIL_SANDBOX_IMAGE=ghcr.io/<owner>/codevil-sandbox:<tag>
export CODEVIL_REGISTRY_USERNAME=...                     # private registries only
export CODEVIL_REGISTRY_PASSWORD=...                     # private registries only
pnpm --filter @codevil/sandbox-image e2b:template -- --dry-run   # print the plan without running it
pnpm --filter @codevil/sandbox-image e2b:template                # build -> push -> template
```

| Name | Required | Purpose |
| --- | --- | --- |
| `E2B_API_KEY` | yes | Authenticates the template build. |
| `CODEVIL_SANDBOX_IMAGE` | yes | Full registry reference that is built, pushed, and used as the template base. |
| `E2B_TEMPLATE_ID` | no | Template name to publish (default `codevil-sandbox`); keep it equal to the Worker's `E2B_TEMPLATE_ID` without the tag. |
| `E2B_TEMPLATE_TAG` | no | Extra tag for this build, so a Worker can pin `<template>:<tag>`; the `default` tag moves with it. CI passes the commit SHA. |
| `CODEVIL_REGISTRY_USERNAME`, `CODEVIL_REGISTRY_PASSWORD` | no | Registry credentials, needed together when the image is private. |

Registry credentials come only from the environment of the person publishing the template. The password is passed to `docker login` over stdin (never as an argument), is never printed, and is never committed or stored in wrangler config. The machine running the script needs Docker, access to push to the registry, and the built image must be pullable by E2B (public, or private with the credentials above).

## Slack integration

The first Slack integration supports one statically configured Slack workspace per Codevil deployment. Any non-bot member of that workspace can configure a channel repository and invoke Codevil, but an Agent Request is created only when `@codevil` is explicitly mentioned.

After deploying Codevil, sign in as an Owner and open:

```text
<worker-origin>/integrations/slack/manifest
```

Create a Slack app from that YAML manifest and install it into the intended workspace. The manifest configures:

- `app_mention` events at `<worker-origin>/slack/events`;
- `/codevil` commands at `<worker-origin>/slack/commands`;
- interactive question actions at `<worker-origin>/slack/actions`;
- `app_mentions:read`, `commands`, `chat:write`, channel/group history and read scopes, and `users:read`.

If the Slack app already exists, regenerate the manifest and update the app configuration so **Interactivity** is enabled with `<worker-origin>/slack/actions` as its request URL. No additional OAuth scope or secret is required.

Copy the app's Bot User OAuth Token and Signing Secret. Obtain the bot user ID from Slack's `auth.test` response (`user_id`) or the Slack app settings, then upload all three values as Worker secrets:

```sh
cd packages/worker
pnpm exec wrangler secret put SLACK_BOT_TOKEN
pnpm exec wrangler secret put SLACK_SIGNING_SECRET
pnpm exec wrangler secret put CODEVIL_SLACK_BOT_USER_ID
cd ../..
pnpm deploy
```

As a signed-in Owner, open `<worker-origin>/integrations/slack/status`. It must report `configured: true`, and `authTest.ok` must be `true`.

Invite the Codevil app to a Slack channel, configure its default repository, and tag it:

```text
/codevil set-repo https://github.com/<owner>/<repo>
@codevil inspect the README and summarize the project
```

The first mention creates one Codevil Session for the Slack thread. Later untagged replies provide discussion context but do not trigger work; the next tagged reply sends that intervening context as a new Agent Request. Slack receives curated start, input-needed, completion, failure, and pull-request milestones. Agent replies use Slack's native Markdown blocks, including tables, headings, lists, links, emphasis, and fenced code. Long replies are split into ordered messages without clipping or breaking code fences. Detailed Activity and Tool Trace output remain in the Codevil web UI.

Option-based agent questions include Slack-native controls. Single-choice questions use buttons or a select menu; multiple-choice questions use checkboxes or a multi-select menu. Any human participant in the linked Slack conversation can answer, and the first valid answer wins. The accepted answer replaces the controls and attributes the result with the answerer's current Slack mention, such as `@krish`.

Free-form-only questions and optional free-form notes use **Open session**. Slack modals, OAuth installation, Slack-to-Codevil account linking, and Slack-native plan approval or refinement remain deferred. Slack-started Agent Runs therefore use Codevil's default execute flow rather than waiting for plan approval.

## Verification

```sh
pnpm verify
```

Some sandbox preview tests bind localhost ports. Run verification in an environment that permits local TCP listeners.

## Contributing / Architecture

- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to set up, verify, and open PRs
- [docs/backend-architecture.md](./docs/backend-architecture.md) — layer-by-layer backend tour for new contributors
- [CONTEXT.md](./CONTEXT.md) — domain vocabulary (Session, Agent Request, Agent Run, etc.)
