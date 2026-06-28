# External Conversation Adapters: Slack v1 Design

**Date:** 2026-06-28
**Status:** Design approved, ready for implementation plan

---

## Overview

Codevil should support Slack as a conversational UI without making the core orchestration model Slack-specific. Slack becomes the first external conversation adapter. The stable Codevil concepts remain unchanged: **Session**, **Agent Request**, **Agent Run**, event log, sandbox, web UI, and team-owned GitHub access.

The v1 Slack integration lets a user mention `@codevil` in a Slack message or thread. Codevil creates or continues one Codevil Session for that Slack thread, resolves the repository from an explicit GitHub repo URL or a channel default, and posts progress back into the same Slack thread. Normal Slack replies are ignored unless they mention `@codevil`.

The design deliberately uses provider-neutral persistence and adapter boundaries so future integrations such as Discord, Teams, Linear, or GitHub comments can reuse the same core flow with different provider adapters.

## Goals

- Treat Slack as an external conversation adapter, not as part of Codevil core.
- Map one Slack app installation to one Codevil team for v1.
- Map one Slack thread to one Codevil Session.
- Start a session when `@codevil` is mentioned in a Slack thread and no session link exists yet.
- Continue the existing session when a later message in the same Slack thread mentions `@codevil`.
- Ignore thread messages that do not mention `@codevil`.
- Use the whole prior Slack thread as initial context when the first `@codevil` mention starts a session.
- On later `@codevil` mentions, inject the message slice since the previous handled Codevil mention as context.
- Resolve repositories from an explicit GitHub repo URL or a channel-level default repo.
- Keep Slack workspace membership sufficient for v1 while preserving correct attribution through external actors.
- Keep the web UI linked from Slack for rich plans, traces, previews, and long output.

## Non-Goals

- Slack modal-based repo selection.
- Requiring every Slack user to link a Codevil account.
- Supporting multiple Codevil teams from one Slack installation.
- Making every Slack thread reply a Codevil request.
- Replacing the web UI.
- Recreating detailed tool traces or previews inside Slack.
- Implementing non-Slack providers in v1.
- Building a general permission policy engine for Slack channels or user groups.

## Design Principles

1. **Core remains provider-neutral.** Durable Objects and session state should not know about Slack `channel_id`, `thread_ts`, bot user IDs, or Slack Block Kit payloads.
2. **Adapters translate at the edge.** Slack request verification, Slack event parsing, Slack API calls, and Slack message rendering live in the Slack adapter.
3. **Stable external identity model.** Slack users are represented as external actors, with optional later linkage to Codevil auth users.
4. **Explicit invocation only.** Codevil acts on Slack messages only when `@codevil` is mentioned.
5. **Thread is the conversation unit.** The external conversation maps to one Codevil Session.
6. **Repo selection is simple in v1.** Use explicit GitHub URL first, channel default second, otherwise ask the user to provide one.

## Architecture

The integration adds an external conversation adapter layer around the existing backend:

```text
External provider event
        ↓
Provider adapter
        ↓
Normalized external conversation event
        ↓
Integration service
        ↓
Existing Codevil session APIs / Orchestrator DO
        ↓
Normalized notification intents
        ↓
Provider adapter renderer
        ↓
External provider thread
```

For v1, Slack is the only provider adapter. The adapter is hosted inside the existing Cloudflare Worker so it can reuse current deployment, D1 access, team configuration, and internal session creation paths.

### Worker Routes

Add Slack-facing routes to the Worker:

```text
/slack/events
/slack/commands
/slack/oauth/callback
```

`/slack/events` handles Slack Events API payloads, verifies Slack request signatures, ignores unsupported events, and dispatches valid app mentions or thread mentions into the integration service.

`/slack/commands` handles v1 slash commands:

```text
/codevil set-repo https://github.com/org/repo
/codevil repo
/codevil clear-repo
```

`/slack/oauth/callback` completes Slack installation from Codevil team settings and stores the installation mapping.

Slack modal routes and interaction handlers are deferred until a later version.

## Provider-Neutral Data Model

The tables should use integration terminology rather than Slack terminology. Provider-specific values live in external ID fields or metadata JSON.

### `integrations`

Represents one external provider installation.

```text
id
team_id
provider                  -- "slack" for v1
external_workspace_id     -- Slack team/workspace id
external_workspace_name
bot_external_actor_id     -- Slack bot user id, when known
config_json
created_at
updated_at
```

For v1, there is exactly one Slack installation per Codevil team. A Slack installation maps to exactly one Codevil team.

Secrets such as Slack bot tokens and signing secrets should be stored using the existing secret/config pattern where possible. If token persistence in D1 is required for OAuth installs, it must be treated as sensitive data and isolated from general metadata.

### `integration_external_actors`

Represents provider users without requiring a Codevil account.

```text
id
integration_id
external_actor_id         -- Slack user id
display_name
email
linked_auth_user_id       -- nullable
metadata_json
created_at
updated_at
```

V1 authorization treats Slack workspace membership as sufficient. Attribution uses this external actor record. If the Slack user later links a Codevil account, `linked_auth_user_id` can be populated without changing existing session links.

### `integration_channels`

Stores provider conversation containers and channel-level defaults.

```text
id
integration_id
external_channel_id       -- Slack channel id
display_name
default_repo_url          -- nullable
metadata_json
created_at
updated_at
```

V1 uses this table for `/codevil set-repo`, `/codevil repo`, and `/codevil clear-repo`.

### `external_session_links`

Maps one external conversation thread to one Codevil Session.

```text
id
integration_id
external_channel_id
external_conversation_id  -- provider-neutral thread/conversation id
session_id
last_handled_message_id
created_by_external_actor_id
created_at
updated_at
```

For Slack:

```text
external_channel_id = Slack channel id
external_conversation_id = Slack thread root ts
last_handled_message_id = Slack message ts of the latest handled @codevil mention
```

### `external_message_dedupe`

Prevents duplicate handling when Slack retries events.

```text
id
integration_id
external_message_id
external_event_id
handled_at
```

The integration service should check this table before creating sessions, sending follow-up requests, or mutating channel defaults.

## Slack Setup and Onboarding

Setup is admin-driven:

1. A Codevil team admin opens Codevil settings and goes to Integrations → Slack.
2. The admin clicks “Add to Slack”.
3. Slack OAuth installs the app into one Slack workspace.
4. Codevil stores the Slack workspace → Codevil team mapping in `integrations`.
5. The admin configures default repos in Slack channels using:

```text
/codevil set-repo https://github.com/org/repo
```

After setup, workspace users can mention `@codevil` in configured channels or include an explicit GitHub repo URL in the message.

## Repository Resolution

When a new session is being created, resolve the repository in this order:

1. Explicit GitHub repository URL found in the triggering message or relevant fetched thread context.
2. Channel default repo from `integration_channels.default_repo_url`.
3. If neither exists, reply in the Slack thread with usage guidance and do not create a session.

Supported explicit forms for v1:

```text
https://github.com/org/repo
http://github.com/org/repo
github.com/org/repo
```

GitHub issue and pull request URLs are deferred for v1. Users should provide a repository URL or rely on a channel default repo.

Before creating a session, Codevil must verify that the configured Codevil team has GitHub access to the resolved repository. If access fails, reply in the Slack thread with a concise error and do not create a session.

## Slack Invocation Behavior

### Starting a Session

A Slack event starts a Codevil Session when:

- the message contains an explicit Codevil mention;
- the message is not from the Codevil bot or another bot message that should be ignored;
- no `external_session_links` row exists for the Slack thread;
- a repository resolves from an explicit GitHub URL or channel default;
- the event has not already been handled.

Start flow:

1. Verify Slack request signature.
2. Resolve the Slack installation and Codevil team.
3. Resolve or create the external actor for the Slack user.
4. Determine the Slack thread root:
   - if the mention is already in a thread, use that thread root;
   - if the mention is a root channel message, that message becomes the thread root.
5. Fetch the entire Slack thread so far.
6. Resolve the repository from thread/message content or channel default.
7. Create a Codevil Session using the existing backend path.
8. Store `external_session_links` for the Slack thread.
9. Send the full fetched thread transcript as initial context.
10. Use the tagged message as the explicit initial user request.
11. Reply in the Slack thread with session status and an “Open in Codevil” link.

The initial request should make the source explicit, for example:

```text
Source: Slack thread
Repository: https://github.com/org/repo
Requester: Slack user display name

Thread context:
...

Explicit request:
...
```

### Continuing a Session

A later Slack event continues a Codevil Session when:

- the message contains an explicit Codevil mention;
- an `external_session_links` row already exists for the Slack thread;
- the event has not already been handled.

Continue flow:

1. Verify Slack request signature.
2. Resolve the existing `external_session_links` row.
3. Fetch Slack thread messages after `last_handled_message_id` through the current mention.
4. Resolve or create the external actor for the Slack user.
5. Send a new Codevil Agent Request into the existing session:
   - include the fetched message slice as context;
   - identify the current tagged message as the explicit request.
6. Update `last_handled_message_id` to the current Slack message id.
7. Reply in the Slack thread that the request was added.

Normal Slack replies without `@codevil` are ignored, even if they occur in a linked thread.

### Context Slice Semantics

The adapter should store the latest handled Codevil mention ID and use provider message ordering to fetch the next context slice.

For Slack, message ordering can be based on `ts` values within the same channel/thread.

Example:

```text
10:00 User A: The deploy failed
10:01 User B: Looks like config changed
10:03 User A: @codevil investigate
        → initial session includes 10:00, 10:01, 10:03
        → last_handled_message_id = 10:03

10:08 User B: I found this log line
10:09 User C: Might be auth
10:10 User A: @codevil also check auth middleware
        → follow-up includes 10:08, 10:09, 10:10
        → explicit request is 10:10
        → last_handled_message_id = 10:10
```

## Outbound Slack Updates

Slack should receive curated session updates, not raw event logs.

V1 should post:

- session started;
- agent request accepted;
- approval requested;
- question asked;
- run completed;
- run failed;
- session stopped or aborted;
- link to open the session in the web UI.

Avoid posting:

- full tool traces;
- long command output;
- raw logs;
- secrets or environment data;
- every low-level phase/event.

The outbound side should use a provider-neutral notification intent internally:

```text
SessionStarted
AgentRequestAccepted
ApprovalRequested
QuestionAsked
RunCompleted
RunFailed
SessionAborted
```

The Slack adapter renders those intents into Slack messages.

For implementation pragmatism, v1 can start with direct Worker/DO-triggered Slack posts for major lifecycle events. If delivery reliability or Slack rate limits become a problem, introduce a queue-backed notification worker without changing the provider-neutral session link model.

## Approvals and Questions

The full workflow requires Slack users to handle agent questions and approvals.

For v1, support text command replies with explicit mentions:

```text
@codevil approve
@codevil abort
@codevil answer: use the production config path
@codevil refine: also check the session refresh code
```

These map onto existing Codevil client messages where possible:

```text
approve / approve_run
abort / abort_run
question_answer
agent_request
refine_plan / refine_run
```

Slack buttons and Block Kit interactions are deferred with the modal work. The provider-neutral design should still model approval/question notifications so buttons can be added later without changing core session flow.

## Authorization and Attribution

V1 uses this trust model:

```text
Slack installation is bound to one Codevil team.
Any non-bot user in that Slack workspace can invoke Codevil through that installation.
Codevil uses the team's configured GitHub access.
Each action is attributed to an external Slack actor.
```

The integration must not invent or fake Codevil `auth_user_id` values. If the Slack user is not linked to a Codevil auth user, the action should be attributed to `integration_external_actors.id`.

Future stricter authorization can require:

- linked Codevil user;
- Codevil team membership;
- allowlisted Slack channels;
- Slack user group membership;
- per-command permission checks.

The schema supports this by keeping `linked_auth_user_id` nullable and preserving provider actor identity separately.

## Error Handling

When repository resolution fails:

```text
I don't know which repo to use for this channel.
Mention a repo URL, e.g.:
@codevil fix the deploy in https://github.com/org/repo

Or configure a channel default:
/codevil set-repo https://github.com/org/repo
```

When GitHub access fails:

```text
Codevil does not have access to https://github.com/org/repo for this team.
Check the team's GitHub integration or use a different repo.
```

When a duplicate Slack event arrives:

- do not create another session;
- do not send another agent request;
- avoid duplicate Slack replies where possible.

When Slack API fetches fail:

- reply with a concise failure if possible;
- do not create a partial session without the expected context unless the failure is recoverable and explicit in the session request.

When Codevil session creation fails:

- reply in the Slack thread with the failure summary;
- do not create an `external_session_links` row unless the session was actually created.

## Security and Privacy

- Verify Slack request signatures and reject stale timestamps.
- Ignore messages from the Codevil bot.
- Do not post secrets, raw logs, or full tool traces into Slack.
- Treat Slack as a shared workspace surface; use the Codevil web UI for detailed traces and rich artifacts.
- Store external actor email only when obtained through approved Slack scopes and needed for future account linking.
- Keep Slack bot tokens out of generic JSON metadata when possible.
- Ensure channel defaults can only be changed through verified Slack commands from the installed workspace.

## Testing

- Signature verification accepts valid Slack signatures and rejects invalid or stale requests.
- Slack event parser detects Codevil mentions and ignores bot/self messages.
- Repo resolver selects explicit GitHub URL before channel default.
- Repo resolver asks for setup when neither explicit URL nor channel default exists.
- `/codevil set-repo`, `/codevil repo`, and `/codevil clear-repo` update/read channel defaults.
- First mention creates one session and one `external_session_links` row.
- Duplicate first mention event does not create a second session.
- Follow-up mention in a linked thread sends a new Agent Request to the same session.
- Non-mention replies in a linked thread are ignored.
- Follow-up context fetch includes messages after the previous handled mention through the current mention.
- External actor attribution works with `linked_auth_user_id = null`.
- Slack installation maps to exactly one Codevil team.
- Outbound renderer posts concise lifecycle updates and includes the web session link.

## Anticipated Files and Modules

The implementation should keep adapter code isolated. Likely additions:

```text
packages/worker/src/integrations/
packages/worker/src/integrations/schema.ts
packages/worker/src/integrations/repository-resolution.ts
packages/worker/src/integrations/external-session-links.ts
packages/worker/src/integrations/notification-intents.ts

packages/worker/src/integrations/slack/
packages/worker/src/integrations/slack/routes.ts
packages/worker/src/integrations/slack/signature.ts
packages/worker/src/integrations/slack/events.ts
packages/worker/src/integrations/slack/commands.ts
packages/worker/src/integrations/slack/client.ts
packages/worker/src/integrations/slack/render.ts
```

Likely existing files touched:

```text
packages/worker/src/http-router.ts
packages/worker/src/http-handlers.ts
packages/worker/src/orchestrator.ts
packages/shared/src/messages-cli.ts
packages/shared/src/projection-* as needed for notification rendering
```

Add D1 migrations for provider-neutral integration tables.

## Open Implementation Notes

- Prefer using existing session creation and WebSocket/DO control paths instead of introducing a separate Slack-only session state machine.
- If direct DO-to-Slack posting becomes awkward, route outbound updates through a small notification service boundary and later back it with Cloudflare Queues.
- Keep Slack Block Kit buttons and modals out of v1 unless text-based approval/question handling proves insufficient.
- When adding future providers, add provider adapters and renderer modules rather than changing session semantics.
