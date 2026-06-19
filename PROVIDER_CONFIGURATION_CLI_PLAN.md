# Provider Configuration CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure interactive CLI that configures deployment-wide OpenCode Go, OpenRouter, and OpenAI API keys as Cloudflare Worker secrets and routes each session to the correct credential.

**Architecture:** A shared provider catalog is the single source of provider IDs, labels, secret names, and validation endpoints. A focused admin CLI package handles hidden prompts, provider API validation, and Wrangler subprocesses; the Worker resolves the selected provider to its dedicated environment secret before provisioning the sandbox, retaining `CODEVIL_LLM_KEY` only as a compatibility fallback.

**Tech Stack:** TypeScript, Node.js built-ins, pnpm workspaces, Cloudflare Wrangler, Node test runner, Cloudflare Workers/Durable Objects.

---

## File structure

- `packages/shared/src/providers.ts`: provider catalog and lookup helpers.
- `packages/shared/test/providers.test.mjs`: catalog contract tests.
- `packages/admin-cli/src/provider-validation.ts`: provider credential validation and result classification.
- `packages/admin-cli/src/wrangler.ts`: Wrangler authentication, secret listing, and bulk upload boundary.
- `packages/admin-cli/src/prompt.ts`: interactive provider selection and hidden input.
- `packages/admin-cli/src/index.ts`: command orchestration.
- `packages/admin-cli/test/*.test.mjs`: pure and orchestration tests.
- `packages/worker/src/provider-credentials.ts`: provider-to-secret resolution with legacy fallback.
- `packages/worker/test/provider-credentials.test.mjs`: resolver and error tests.
- `packages/worker/src/orchestrator.ts`: redaction and sandbox provisioning integration.
- `package.json`, `README.md`, `PRODUCTION_READINESS.md`, `packages/site/src/lib/commands.ts`: command wiring and self-hosting guidance.

### Task 1: Shared provider catalog

**Files:**
- Create: `packages/shared/src/providers.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/providers.test.mjs`

- [ ] **Step 1: Write the failing catalog tests**

Test that `getProviderDefinition("opencode")` aliases to OpenCode Go, that all canonical definitions have unique secret names, and that unknown providers return `undefined`.

```js
import assert from "node:assert/strict";
import test from "node:test";
import { LLM_PROVIDERS, getProviderDefinition } from "../dist/index.js";

test("supports the initial deployment-wide providers", () => {
  assert.deepEqual(LLM_PROVIDERS.map(({ id }) => id), ["opencode-go", "openrouter", "openai"]);
  assert.equal(getProviderDefinition("opencode")?.id, "opencode-go");
  assert.equal(getProviderDefinition("unknown"), undefined);
  assert.equal(new Set(LLM_PROVIDERS.map(({ secretName }) => secretName)).size, 3);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --filter @codevil/shared test`

Expected: FAIL because `LLM_PROVIDERS` and `getProviderDefinition` are not exported.

- [ ] **Step 3: Implement the provider catalog**

Define this immutable contract and export it from `packages/shared/src/index.ts`:

```ts
export type LLMProviderId = "opencode-go" | "openrouter" | "openai";

export interface LLMProviderDefinition {
  id: LLMProviderId;
  aliases: readonly string[];
  displayName: string;
  secretName: "OPENCODE_API_KEY" | "OPENROUTER_API_KEY" | "OPENAI_API_KEY";
  validationUrl: string;
  keyHelpUrl: string;
}

export const LLM_PROVIDERS: readonly LLMProviderDefinition[] = [
  { id: "opencode-go", aliases: ["opencode"], displayName: "OpenCode Go", secretName: "OPENCODE_API_KEY", validationUrl: "https://opencode.ai/zen/go/v1/models", keyHelpUrl: "https://opencode.ai/docs/go/" },
  { id: "openrouter", aliases: [], displayName: "OpenRouter", secretName: "OPENROUTER_API_KEY", validationUrl: "https://openrouter.ai/api/v1/key", keyHelpUrl: "https://openrouter.ai/settings/keys" },
  { id: "openai", aliases: [], displayName: "OpenAI Platform", secretName: "OPENAI_API_KEY", validationUrl: "https://api.openai.com/v1/models", keyHelpUrl: "https://platform.openai.com/api-keys" },
];

export function getProviderDefinition(provider: string): LLMProviderDefinition | undefined {
  return LLM_PROVIDERS.find((candidate) => candidate.id === provider || candidate.aliases.some((alias) => alias === provider));
}
```

- [ ] **Step 4: Run the shared tests and verify GREEN**

Run: `pnpm --filter @codevil/shared test`

Expected: all shared tests pass.

- [ ] **Step 5: Commit the catalog slice**

Run: `git add packages/shared/src/providers.ts packages/shared/src/index.ts packages/shared/test/providers.test.mjs && git commit -m "feat: define supported LLM providers"`

### Task 2: Worker provider credential resolution

**Files:**
- Create: `packages/worker/src/provider-credentials.ts`
- Modify: `packages/worker/src/index.ts`
- Modify: `packages/worker/src/orchestrator.ts`
- Test: `packages/worker/test/provider-credentials.test.mjs`

- [ ] **Step 1: Write failing resolver tests**

Cover each canonical provider, the `opencode` alias, legacy fallback, unknown provider, and the actionable missing-configuration error.

```js
assert.equal(resolveProviderCredential({ OPENROUTER_API_KEY: "or-key" }, "openrouter"), "or-key");
assert.equal(resolveProviderCredential({ OPENCODE_API_KEY: "oc-key" }, "opencode"), "oc-key");
assert.equal(resolveProviderCredential({ CODEVIL_LLM_KEY: "legacy" }, "openai"), "legacy");
assert.throws(() => requireProviderCredential({}, "openai"), /OpenAI Platform is not configured.*pnpm providers/);
```

- [ ] **Step 2: Run the worker tests and verify RED**

Run: `pnpm --filter @codevil/worker test`

Expected: FAIL because `provider-credentials.js` does not exist.

- [ ] **Step 3: Implement the resolver**

```ts
export interface ProviderCredentialEnv {
  OPENCODE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CODEVIL_LLM_KEY?: string;
}

export function resolveProviderCredential(env: ProviderCredentialEnv, provider: string): string | undefined {
  const definition = getProviderDefinition(provider);
  if (!definition) return env.CODEVIL_LLM_KEY;
  return env[definition.secretName] || env.CODEVIL_LLM_KEY;
}

export function requireProviderCredential(env: ProviderCredentialEnv, provider: string): string {
  const key = resolveProviderCredential(env, provider);
  if (key) return key;
  const name = getProviderDefinition(provider)?.displayName ?? provider;
  throw new Error(`${name} is not configured. Run \`pnpm providers\` on the Codevil host.`);
}
```

- [ ] **Step 4: Integrate the resolver into sandbox provisioning**

Add the three optional provider secrets to both Worker `Env` interfaces, include all provider credentials in `redactionSecrets`, call `requireProviderCredential()` before `provisionSandbox()`, and pass the returned key as `llmKey`. Replace `has_llm_key` with a boolean derived from the resolved key.

- [ ] **Step 5: Run worker tests and verify GREEN**

Run: `pnpm --filter @codevil/worker test`

Expected: all Worker tests pass, including resolver and redaction coverage.

- [ ] **Step 6: Commit the Worker routing slice**

Run: `git add packages/worker/src/provider-credentials.ts packages/worker/src/index.ts packages/worker/src/orchestrator.ts packages/worker/test/provider-credentials.test.mjs && git commit -m "feat: route sessions to provider credentials"`

### Task 3: Provider validation package

**Files:**
- Create: `packages/admin-cli/package.json`
- Create: `packages/admin-cli/tsconfig.json`
- Create: `packages/admin-cli/src/provider-validation.ts`
- Create: `packages/admin-cli/test/provider-validation.test.mjs`

- [ ] **Step 1: Scaffold the private workspace package**

Use package name `@codevil/admin-cli`, depend on `@codevil/shared`, and provide `build`, `typecheck`, and `test` scripts matching the other Node packages.

- [ ] **Step 2: Write failing validation tests**

Use an injected fetch function and assert the exact URL and bearer header. Classify `2xx` as `valid`, `401/403` as `invalid`, and network errors or other statuses as `unavailable` without including response bodies.

```ts
export type CredentialValidation =
  | { status: "valid" }
  | { status: "invalid"; message: string }
  | { status: "unavailable"; message: string };
```

- [ ] **Step 3: Run the package tests and verify RED**

Run: `pnpm --filter @codevil/admin-cli test`

Expected: FAIL because `validateProviderCredential` is missing.

- [ ] **Step 4: Implement minimal validation**

`validateProviderCredential(definition, key, fetcher = fetch)` performs a GET to `definition.validationUrl` with `Authorization: Bearer ${key}` and `Accept: application/json`. It returns fixed provider-safe messages and never reads or includes the response body.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `pnpm --filter @codevil/admin-cli test`

Expected: all validation tests pass.

- [ ] **Step 6: Commit the validation slice**

Run: `git add packages/admin-cli/package.json packages/admin-cli/tsconfig.json packages/admin-cli/src/provider-validation.ts packages/admin-cli/test/provider-validation.test.mjs && git commit -m "feat: validate provider credentials"`

### Task 4: Wrangler boundary and interactive orchestration

**Files:**
- Create: `packages/admin-cli/src/wrangler.ts`
- Create: `packages/admin-cli/src/prompt.ts`
- Create: `packages/admin-cli/src/configure-providers.ts`
- Create: `packages/admin-cli/src/index.ts`
- Test: `packages/admin-cli/test/wrangler.test.mjs`
- Test: `packages/admin-cli/test/configure-providers.test.mjs`

- [ ] **Step 1: Write failing Wrangler boundary tests**

Inject a process runner. Assert that authentication uses `pnpm --filter @codevil/worker exec wrangler whoami --json`, configured status uses `secret list --format json`, and upload uses `secret bulk` with JSON on stdin. Assert keys never appear in argv.

- [ ] **Step 2: Implement the Wrangler boundary**

Expose:

```ts
export interface WranglerClient {
  whoami(): Promise<void>;
  configuredSecrets(): Promise<Set<string>>;
  uploadSecrets(secrets: Record<string, string>): Promise<void>;
}
```

Use `node:child_process.spawn`, workspace root as `cwd`, piped stdin for upload, and inherited/collected diagnostics that never echo the JSON input.

- [ ] **Step 3: Write failing orchestration tests**

With fake prompt, validator, and Wrangler client, prove that the flow:

- shows configured provider names;
- accepts one or more numeric selections;
- rejects blank keys;
- stops on invalid credentials;
- lets the user retry or skip an unavailable validation;
- uploads only selected valid/skipped credentials;
- prints no key values.

- [ ] **Step 4: Implement terminal prompting**

Provide a numbered selection parser and a hidden-input prompt that uses raw TTY mode. Restore raw mode and terminal echo in `finally`, including SIGINT/error paths. Reject non-TTY execution with a message explaining that CLI flags are intentionally unsupported for secrets.

- [ ] **Step 5: Implement command orchestration and entrypoint**

`configureProviders()` runs preflight, status display, selection, hidden key collection, validation, one bulk upload, and a provider-only summary. `src/index.ts` handles `providers` and `--help`, sets a non-zero exit code on failure, and never prints an error object's arbitrary response body.

- [ ] **Step 6: Run admin CLI tests and verify GREEN**

Run: `pnpm --filter @codevil/admin-cli test`

Expected: all admin CLI tests pass.

- [ ] **Step 7: Commit the interactive CLI slice**

Run: `git add packages/admin-cli/src packages/admin-cli/test && git commit -m "feat: add provider configuration CLI"`

### Task 5: Command wiring and self-hosting documentation

**Files:**
- Modify: `package.json`
- Modify: `packages/worker/.env.example`
- Modify: `README.md`
- Modify: `PRODUCTION_READINESS.md`
- Modify: `packages/site/src/lib/commands.ts`
- Modify: `packages/site/src/lib/__tests__/commands.test.ts`

- [ ] **Step 1: Update the site command test first**

Require the quick start to include `pnpm providers` and remove `CODEVIL_LLM_KEY` from required manual credentials.

- [ ] **Step 2: Run the site test and verify RED**

Run: `pnpm --filter @codevil/site test`

Expected: FAIL because current commands still instruct users to edit `CODEVIL_LLM_KEY`.

- [ ] **Step 3: Add root command wiring**

Add:

```json
"providers": "pnpm --filter @codevil/admin-cli build && node packages/admin-cli/dist/index.js providers"
```

Keep the command rerunnable independently of the broader bootstrap flow.

- [ ] **Step 4: Update setup documentation**

Document this order: deploy Worker, run migrations, run `pnpm providers`, configure Google/GitHub credentials through the bootstrap path, then claim the instance. Remove provider keys from `.env.production`; preserve only bootstrap/auth/GitHub inputs still needed by the current deployment flow.

- [ ] **Step 5: Run focused tests**

Run:

```sh
pnpm --filter @codevil/shared test
pnpm --filter @codevil/admin-cli test
pnpm --filter @codevil/worker test
pnpm --filter @codevil/site test
```

Expected: all focused suites pass.

- [ ] **Step 6: Commit command wiring and documentation**

Run: `git add package.json packages/worker/.env.example README.md PRODUCTION_READINESS.md packages/site/src/lib/commands.ts packages/site/src/lib/__tests__/commands.test.ts && git commit -m "docs: guide provider configuration"`

### Task 6: Full verification

**Files:** No production changes expected.

- [ ] **Step 1: Run typechecking**

Run: `pnpm typecheck`

Expected: exit 0 for every workspace package.

- [ ] **Step 2: Run the complete test gate**

Run: `pnpm test`

Expected: exit 0; sandbox preview tests require permission to bind localhost ports.

- [ ] **Step 3: Run production builds**

Run: `pnpm build`

Expected: exit 0 for all packages.

- [ ] **Step 4: Validate Wrangler bindings**

Run from `packages/worker`:

```sh
pnpm exec wrangler types /tmp/codevil-worker-configuration.d.ts --include-runtime=false
```

Expected: generated `Env` includes `OPENCODE_API_KEY`, `OPENROUTER_API_KEY`, and `OPENAI_API_KEY` after declaring them in the Worker environment contract.

- [ ] **Step 5: Review the diff**

Confirm no provider key appears in tracked files, test fixtures use obvious fake values, unrelated UI work is unchanged, and only the approved provider scope was implemented.
