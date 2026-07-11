# Sandbox Hardening Follow-up Design

## Goal

Complete the production-hardening branch by removing duplicated security primitives, detecting Pi provider-policy drift, making capability rotation independent of long-running agent work, reducing event-log append cost, strengthening proxy observability, validating the rebuilt sandbox image, and documenting the deployment trust boundary.

The work preserves the current product policy: a Session may read any GitHub repository accessible to the deployment PAT, while writes remain limited to the Session's primary repository. One self-hosted deployment is one trusted Team boundary; this design does not introduce per-Member GitHub authorization.

## Scope

This iteration will:

1. Replace the separate LLM, Git, and sandbox-WebSocket HMAC implementations with one Worker-internal capability-token primitive.
2. Use one token format with Unix-second `iat` and `exp`, explicit audience, maximum lifetime, bounded clock skew, and strict payload validation.
3. Keep client WebSocket authentication separate unless extracting the primitive is demonstrably compatible with its Better Auth/member authorization semantics.
4. Process `proxy_capabilities` outside the sandbox runtime's serialized main-work queue so token rotation cannot wait behind an Agent Run.
5. Pass the sandbox WebSocket base URL and token separately; construct the credential-bearing URL only inside the entrypoint.
6. Keep the Codevil-owned provider outbound allowlist, but add a CI test that compares supported Pi model base URLs and API protocols with the policy pinned in the installed Pi version.
7. Replace the event log's per-append SQLite `COUNT(*)` with an in-memory tail counter hydrated once from SQLite and reset after a successful snapshot checkpoint.
8. Add normalized proxy telemetry for rejection category, operation, provider/API, upstream status, and latency without logging target paths, query strings, bodies, credentials, or capability tokens.
9. Add an executable sandbox-image smoke check covering the unprivileged UID, process startup, workspace IO, and HTTP preview reachability.
10. Remove CodeQL and dependency-review workflows while the repository is private; retain ordinary CI and Dependabot.
11. Update architecture/deployment documentation for proxy credentials, capability rotation, provider-policy ownership, and PAT-wide reads.
12. Remove or rewrite review todos that no longer reflect accepted product policy.

## Existing Work Preservation

The working tree already contains uncommitted Git proxy improvements. They install a session-scoped Git credential helper, store the rotating capability in a mode-0600 file, configure GitHub URL rewriting for agent-initiated Git commands, and accept the exact bare proxy route required by Git's `insteadOf` behavior.

These changes are treated as input to this design. Follow-up work must not discard or rewrite them wholesale. Tests will establish their intended behavior before adjacent refactoring.

## Architecture

### Capability token primitive

Create a focused Worker module responsible only for signed capability envelopes. A token contains:

- version;
- audience (`sandbox_llm`, `sandbox_git`, or `sandbox_ws`);
- issued-at time in Unix seconds;
- expiry time in Unix seconds;
- unique token identifier;
- audience-specific claims.

Issuance requires a non-empty secret and a bounded positive TTL. Verification performs signature comparison before parsing claims, then rejects unknown versions, wrong audiences, malformed timestamps, future issuance beyond clock skew, expiry, and lifetimes greater than the audience's configured maximum.

Audience-specific modules remain responsible for semantic claims such as provider/API tuples, repository names, and Session IDs. This keeps the shared signer generic without weakening type-specific validation.

Breaking the existing branch-only token formats is intentional; no rolling compatibility is required.

### Capability delivery and rotation

The Worker issues all LLM, Git, and sandbox-WebSocket capabilities together. The sandbox requests refresh on connect and at a fixed interval shorter than the token TTL.

Incoming `proxy_capabilities` messages are intercepted by the entrypoint before the normal dispatcher. It immediately:

1. replaces the future reconnect WebSocket token;
2. updates the Git credential-helper token file atomically;
3. updates the active Pi driver's runtime credentials.

The rotation operation has its own short promise lane to preserve refresh ordering without waiting behind planning, execution, verification, or preview work. Errors are logged using normalized metadata and trigger another refresh request; credentials are never included.

The process environment receives a credential-free `CODEVIL_DO_WS_URL` plus `CODEVIL_SANDBOX_WS_TOKEN`. The URL query parameter exists only in the in-memory URL passed to the WebSocket constructor.

### Provider policy verification

Codevil remains the authority deciding where Worker-held credentials may be sent. Pi metadata is compatibility input, not authorization input.

A test loads the installed Pi catalog for each Codevil-supported provider/model and checks that:

- every runnable model's API appears in that provider's Codevil auth policy;
- every concrete model base-URL hostname is in that provider's allowlist;
- templated public configuration resolves only declared Codevil configuration keys;
- no supported Codevil policy is orphaned from the pinned Pi catalog unless explicitly annotated as a compatibility exception.

The test fails on Pi upgrades. It never automatically adds a host or auth rule; a human must review security-boundary changes.

Product catalog fields and outbound authorization fields should be named and documented separately. A larger registry split is allowed only where it reduces ambiguity without duplicating data.

### Event-log tail accounting

`SessionEventLog` owns an `eventsSincePersistedSnapshot` counter. Hydration performs one `COUNT(*) WHERE id > lastPersistedSnapshotCursor`. Each append increments the counter. A successful snapshot persistence resets it to zero. A failed or oversized snapshot leaves it unchanged so compaction will be retried.

This preserves the existing checkpoint semantics while making the hot append path constant-time with no aggregate query.

### Proxy telemetry

Proxy telemetry records only bounded, normalized fields:

- proxy kind: LLM or Git;
- outcome/rejection category;
- provider and API for LLM requests;
- read/write for Git requests;
- upstream status class and duration;
- Session trace identifier where available.

It must not record repository names for cross-repository reads, provider URL paths, query strings, headers, request or response bodies, tokens, keys, or raw upstream errors. Telemetry failures never affect proxy responses.

### Sandbox image smoke verification

The smoke check builds the real `Dockerfile.sandbox`, starts the image through its declared entrypoint, and verifies the runtime can launch an unprivileged process that:

- reports UID 10001;
- writes and reads `/workspace`;
- starts an HTTP server on an exposed preview port;
- returns a successful health response.

If Cloudflare's sandbox server needs environment-specific control calls, the smoke harness will use its supported local interface rather than replacing the entrypoint. The test belongs in the sandbox-image CI job and must clean up its container on success or failure.

## Error Handling

- Capability verification returns authentication failure without exposing the rejection detail to the sandbox; normalized rejection categories are observable server-side.
- Refresh failure retains the previous still-valid capability and schedules a retry. Expired capabilities fail closed.
- Provider-policy drift fails tests with the provider, model, API, and hostname needed for a human policy decision.
- Event-counter hydration failure follows the existing SQLite failure behavior and must not fabricate a checkpoint.
- Docker smoke failures print bounded container diagnostics and return a failing CI status.

## Testing Strategy

Implementation follows red-green-refactor for each behavior:

- capability primitive tests cover round trip, audience mismatch, tampering, malformed input, expiry, excessive lifetime, future `iat`, clock skew, and empty secrets;
- existing LLM/Git/WebSocket tests migrate to the unified format and continue testing semantic scope;
- dispatcher tests prove refresh completes while a deliberately blocked main Agent Run remains pending;
- environment tests prove the base WebSocket URL contains no token;
- Pi compatibility tests inspect the real pinned dependency catalog;
- event-log tests instrument SQLite and prove repeated appends do not issue repeated `COUNT(*)` queries;
- telemetry tests prove normalized fields are present and secrets/paths are absent;
- sandbox smoke test exercises the built image;
- package typechecks and tests run after each slice, followed by `pnpm verify` and the Docker build/smoke check.

## Documentation and Repository Configuration

Update `docs/backend-architecture.md` and the relevant deployment/configuration examples to state:

- provider and GitHub credentials remain in the Worker;
- the sandbox receives short-lived bearer capabilities;
- Codevil's provider policy is an independent credential boundary verified against pinned Pi metadata;
- one deployment's PAT permits read access to all repositories visible to that PAT;
- writes are restricted to the Session's primary repository;
- deployments requiring per-user or per-repository isolation need a future GitHub App authorization design.

Delete `.github/workflows/codeql.yml` and `.github/workflows/dependency-review.yml` while the repository is private. Their restoration after public release is an explicit release checklist item, not a silently skipped workflow.

## Non-goals

- GitHub App installation tokens or per-Member repository authorization.
- Backward compatibility with capabilities issued by the unmerged branch.
- Dynamically trusting Pi-provided hosts or authentication headers.
- Redesigning client/member WebSocket authorization.
- General observability-platform changes unrelated to the proxy.
- Solving all historical architecture gaps documented elsewhere in the repository.

## Completion Criteria

- All three sandbox capability types use the shared token primitive and strict audience validation.
- Long Agent Runs cannot delay capability rotation.
- Sandbox process configuration contains no tokenized WebSocket URL.
- A Pi upgrade that changes relevant API/host metadata fails a compatibility test.
- Event append performs no repeated tail `COUNT(*)` query after hydration.
- Proxy telemetry is useful without exposing sensitive request data.
- The built sandbox image passes an end-to-end local smoke check in CI.
- Unsupported private-repository security workflows are removed.
- Documentation accurately describes the Team/PAT trust boundary.
- All typechecks, unit tests, integration tests, and Docker checks pass.
