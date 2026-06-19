# Codevil

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

Deploy the Worker and apply its remote D1 migrations:

```sh
cd ../..
pnpm deploy
cd packages/worker
pnpm exec wrangler d1 migrations apply DB --remote
```

Wrangler creates and binds the D1 database automatically. The Worker, web UI, Durable Objects, and sandbox container ship as one deployment. Return to the repository root and configure one or more LLM providers:

```sh
cd ../..
pnpm providers
```

`pnpm providers` uses hidden TTY prompts and attempts to validate every selected provider credential before uploading it directly as a deployment-wide Cloudflare Worker secret. If validation is unavailable, the operator must explicitly retry, skip validation, or cancel. The command accepts no secret flags and can be rerun to add providers or rotate keys. Provider keys are not stored in D1 or project files.

In the Google OAuth client, add the deployed Worker origin as an authorized JavaScript origin and add `<worker-origin>/api/auth/callback/google` as an authorized redirect URI. Google OAuth is required even if GitHub is configured.

Open the Worker URL, sign in with Google, claim the first owner account using `CODEVIL_SETUP_TOKEN`, and invite the rest of the team.

## Verification

```sh
pnpm verify
```

Some sandbox preview tests bind localhost ports. Run verification in an environment that permits local TCP listeners.

See [SPEC.md](./SPEC.md) for the architecture and [CONTEXT.md](./CONTEXT.md) for domain terminology.
