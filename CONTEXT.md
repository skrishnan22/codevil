# Codevil

Codevil is an AI coding agent platform that runs one coding task as an isolated session and exposes its progress, outputs, and review surfaces to users.

## Language

**Session**:
One Codevil task workspace from creation through Agent Requests, execution, inspection, verification, and completion.
_Avoid_: Trace, job, run

**Agent Request**:
A user-directed request for Pi to do work inside an existing Session.
_Avoid_: Prompt when referring to the durable user intent

**Agent Run**:
One execution of an Agent Request by Pi, from queue/start through work, verification, optional publishing, and return to the Session.
_Avoid_: Session

**Plan**:
A proposal Pi may produce during an Agent Run when it helps explain or organize work; it is not the default gate before execution.
_Avoid_: Approval step when referring to the default web flow

**Activity**:
The user-facing stream or workspace for inspecting what happened during a session.
_Avoid_: Trace

**Conversation**:
The durable user-facing exchange of prompts, decisions, attention items, and milestones within a session.
_Avoid_: Timeline when referring to user-facing conversation history

**Assistant Stream**:
The live assistant text emitted while Pi is processing a prompt.
_Avoid_: Agent Message

**Assistant Reply**:
The finalized assistant text for a prompt after Pi reaches `agent_end`, unless Codevil has already promoted it into a more specific session event.
_Avoid_: Assistant Stream

**Tool Trace**:
The detailed record of tool calls, thinking entries, inputs, and outputs produced while the agent works.
_Avoid_: Activity log when referring to low-level inspection data

**Team**:
The set of active Members allowed to use one self-hosted Codevil deployment. In v1, the Team is implicit: the deployment is the Team boundary, not a database row.
_Avoid_: Organization, tenant

**Auth User**:
The local identity created from an authenticated external account such as Google. An Auth User may exist without being allowed to use Codevil.
_Avoid_: Member when the user does not have active access

**Member**:
An Auth User with an active Membership in the Team.
_Avoid_: User when referring to access rights

**Membership**:
The access grant that makes an Auth User a Member of the Team. Membership carries the Member's role and status.
_Avoid_: Account

**Role**:
A fixed access level on a Membership.
_Avoid_: Permission set when referring to the v1 fixed role label

**Owner**:
A Member with full administrative control over the Team. The first Owner is created through setup claim; later Owners are invited by existing Owners.
_Avoid_: Admin when referring to first setup authority

**Invite**:
A one-time, expiring invitation for a specific verified email address to become a Member after authenticating.
_Avoid_: Login link, magic link

## Relationships

- A **Session** has one user-facing **Activity** surface.
- A **Session** has one **Conversation**.
- A **Session** produces one **Tool Trace**.
- A **Session** may contain many **Agent Requests**.
- An **Agent Request** produces one **Agent Run**.
- An **Agent Run** may produce a **Plan**, **Assistant Replies**, **Activity**, and **Tool Trace**.
- A **Plan** does not require an approval pause in the default web flow.
- **Activity** may summarize or link into the **Tool Trace**.
- **Conversation** includes **User Messages**, **Assistant Replies**, and promoted session events, not every raw **Assistant Stream** or **Tool Trace** entry.
- A **Team** is the implicit boundary of one self-hosted Codevil deployment.
- A deployment's GitHub credential is a **Team-level** integration: Sessions may read any repository visible to that credential, while Git writes remain scoped to the Session's primary repository.
- An **Auth User** becomes a **Member** only through an active **Membership**.
- A **Membership** has one **Role**.
- An **Owner** is a Member.
- An **Invite** does not authenticate a person; it permits Membership creation after authentication.

## Example Dialogue

> **Dev:** "Should the right workspace tab be called Trace?"
> **Domain expert:** "No. **Trace** already means observability data. Use **Activity** for the user-facing tab, and **Tool Trace** for detailed tool-call inspection."
>
> **Dev:** "Should every streamed agent delta appear in the **Conversation**?"
> **Domain expert:** "No. The live **Assistant Stream** belongs in **Activity** or the current-agent card. The finalized **Assistant Reply** can appear in **Conversation** when Pi reaches `agent_end`."
>
> **Dev:** "Does every **Agent Run** need to stop at a **Plan** for approval before doing work?"
> **Domain expert:** "No. Pi may produce a **Plan** when useful, but plan approval is not the default **Session** execution loop."

## Flagged Ambiguities

- "trace" was used for both observability traces and the UI's detailed tool-call inspector. Resolved: use **Activity** for the user-facing tab and **Tool Trace** for detailed tool-call inspection.
- "timeline" was used for both chronological UI mechanics and user-facing conversation history. Resolved: use **Conversation** for the left-side durable stream.
- "agent message" was used for both live assistant streaming text and finalized assistant output. Resolved: use **Assistant Stream** for live Pi text and **Assistant Reply** for finalized text after `agent_end`.
- "team" can sound like a tenant row in SaaS products. Resolved: in Codevil v1, **Team** is implicit and means the people with active Membership in one self-hosted deployment.
- "plan" was used as both an optional agent artifact and a required approval gate. Resolved: **Plan** is optional in the default web flow and does not imply approval.

## Security Boundaries

- Provider credentials and the GitHub PAT remain in the Worker. A sandbox receives only short-lived, audience-bound capabilities for LLM, Git, and sandbox-WebSocket access.
- Codevil's provider host/API/header registry is an independent credential-release policy, not a dynamically trusted copy of Pi configuration. Compatibility tests compare it with the pinned Pi model catalog and require human review when Pi changes hosts or protocols.
- Capability rotation bypasses the serialized Agent Run queue so long-running work cannot prevent renewal.
- The deployment PAT is a Team-level integration. Sessions may read any repository visible to it so an Agent Run can consult related repositories; Git writes remain limited to the Session's primary repository.
- CodeQL and dependency-review workflows remain disabled while the repository is private. Restore them and enable GitHub Code Scanning and Dependency Graph when the repository becomes public.
