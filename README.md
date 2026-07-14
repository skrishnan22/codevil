# Codevil

[![CI](https://github.com/skrishnan22/codevil/actions/workflows/ci.yml/badge.svg)](https://github.com/skrishnan22/codevil/actions/workflows/ci.yml)

Codevil is a self-hosted AI coding agent platform. Each coding session runs in an isolated Cloudflare Sandbox and streams its progress to a collaborative web UI.

## Self-hosting

Prerequisites: Node.js 20+, pnpm 10, a Cloudflare account with Workers Containers access, a Google OAuth client, at least one supported provider API key, and a fine-grained GitHub token.

Install dependencies, authenticate Wrangler, and prepare the auth, GitHub, and bootstrap secrets:

```sh
pnpm install
pnpm exec wrangler login
cp packages/worker/.env.example packages/worker/.env.production
```

Set `GITHUB_PAT`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in `packages/worker/.env.production`. Generate independent random values for `CODEVIL_API_KEY`, `CODEVIL_SETUP_TOKEN`, and `BETTER_AUTH_SECRET` by running this command separately for each secret and pasting a different result each time:

```sh
openssl rand -hex 32
```

Replace every `REPLACE_ME` placeholder before upload. Never upload the example placeholders unchanged. Once all six values are set, upload the file through Wrangler's existing bootstrap path:

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

In the Google OAuth client, add the deployed Worker origin as an authorized JavaScript origin and add `<worker-origin>/api/auth/callback/google` as an authorized redirect URI. Google OAuth is required even if GitHub is configured.

Open the Worker URL, sign in with Google, claim the first owner account using `CODEVIL_SETUP_TOKEN`, and invite the rest of the team.

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
