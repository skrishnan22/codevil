# Contributing

## Prerequisites

- Node.js 20 or later
- pnpm 10 (see `packageManager` in the root `package.json`)
- Docker (required to build the sandbox container image locally)

## Setup

```sh
pnpm install
```

## Quality gate

All changes must pass:

```sh
pnpm verify
```

This runs typecheck and tests across workspace packages.

## Per-package tests

Run tests for a single package:

```sh
pnpm --filter @codevil/worker test
pnpm --filter @codevil/sandbox-image test
pnpm --filter @codevil/shared test
pnpm --filter @codevil/cli test
pnpm --filter @codevil/web test
pnpm --filter @codevil/site test
pnpm --filter @codevil/admin-cli test
```

## Package map

- `@codevil/worker` — Cloudflare Worker control plane (Durable Objects, D1, auth, session routing)
- `@codevil/sandbox-image` — Container runtime that runs the Pi coding agent inside Cloudflare Sandbox
- `@codevil/shared` — Shared types and protocol definitions
- `@codevil/cli` — End-user CLI for interacting with a Codevil deployment
- `@codevil/web` — React SPA for the collaborative coding UI
- `@codevil/site` — Marketing/docs site (Astro)
- `@codevil/admin-cli` — Operator tooling (provider configuration, deployment helpers)

## Domain vocabulary

Read [docs/backend-architecture.md](docs/backend-architecture.md) and [CONTEXT.md](CONTEXT.md) before changing control-plane or sandbox behavior.

## Pull requests

Behavior changes need tests. CI runs `pnpm verify` and builds `Dockerfile.sandbox` on every pull request.
