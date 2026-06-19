# Provider configuration CLI design

## Objective

Give a self-hosting administrator a guided, secure way to configure deployment-wide LLM credentials without editing files, copying Wrangler commands, or exposing keys in shell history.

The initial providers are:

- OpenCode Go (`opencode-go`, secret `OPENCODE_API_KEY`)
- OpenRouter (`openrouter`, secret `OPENROUTER_API_KEY`)
- OpenAI Platform (`openai`, secret `OPENAI_API_KEY`)

OpenAI Codex subscription OAuth is out of scope. The OpenAI integration uses Platform API keys suitable for a shared deployment.

## User experience

The administrator runs:

```sh
pnpm providers
```

The command:

1. Checks Node, Wrangler availability, Cloudflare authentication, and whether the Codevil Worker exists.
2. Shows the three supported providers and the names of any already-configured provider secrets.
3. Lets the administrator select one or more providers by number.
4. Prompts for each selected key using hidden terminal input.
5. Validates each credential against that provider's API. Authentication failures stop the upload; transient provider failures offer a clear retry or skip-validation path.
6. Uploads all selected credentials in one Wrangler bulk-secret request through stdin.
7. Prints provider names and validation status, never key values or key fragments.

The command is rerunnable. Reconfiguring a provider replaces only that provider's secret. Providers not selected remain unchanged.

## Security model

- Provider keys are Cloudflare Worker secrets, not D1 records.
- Keys are read only from hidden interactive prompts.
- Keys are never passed as command-line arguments, written to `.env` files, logged, echoed, or retained after the process exits.
- The setup process uses the administrator's existing Wrangler authentication. The deployed Worker receives no Cloudflare account-management token.
- Wrangler output is filtered only for accidental secret reflection; normal diagnostic output remains visible.
- Tests use synthetic credentials and injected subprocess/fetch boundaries.

## Runtime contract

The Worker resolves a session's provider to a dedicated secret:

| Session provider | Worker secret |
| --- | --- |
| `opencode-go` or `opencode` | `OPENCODE_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `openai` | `OPENAI_API_KEY` |

The selected credential is copied into the sandbox's existing tmpfs secret file, read once by the sandbox entrypoint, and unlinked. Provider credentials are included in event redaction before anything is persisted.

`CODEVIL_LLM_KEY` remains a temporary fallback for existing installations but is removed from new setup instructions.

If a session selects an unconfigured provider, creation fails before sandbox provisioning with an actionable error naming the missing provider configuration, not the secret variable.

## Components

### Provider catalog

A small shared catalog defines stable provider IDs, display names, Worker secret names, key-help URLs, and validation behavior. The setup CLI and Worker both consume this catalog so mappings cannot drift.

### Interactive command

The command owns terminal interaction and orchestration. Pure helpers handle selection parsing, configuration status, validation outcomes, and user-facing summaries. Process execution and network requests are injected at the boundary for deterministic tests.

### Worker credential resolver

A pure resolver selects the credential for a provider and reports whether it is configured. The orchestrator uses it before provisioning and includes every configured provider key in its redaction set.

## Error handling

- Non-interactive terminals fail with instructions for future automation support; keys are not accepted as CLI flags.
- Missing Wrangler authentication points to `pnpm exec wrangler login`.
- Missing Worker deployment instructs the administrator to run the bootstrap/deploy step first.
- Invalid credentials identify the provider and validation failure without including response bodies that may echo secrets.
- Bulk upload failure leaves existing secrets unchanged according to Wrangler's request semantics and returns the original Wrangler diagnostic.
- Interrupts restore terminal echo before exiting.

## Testing

- Provider catalog and secret resolution unit tests.
- Selection and rerun behavior tests.
- Credential validation tests for success, authentication failure, and transient failure.
- CLI orchestration tests with fake prompts, fetch, and Wrangler execution.
- Worker tests proving each provider receives only its mapped credential and that legacy fallback still works.
- Redaction tests covering all configured provider secrets.
- Full workspace typecheck and test gate.

## Follow-up scope

The same CLI can later add Anthropic, Gemini, and other Pi providers. OAuth-based providers require a separate credential lifecycle and are not represented as static API-key providers in this first version.

