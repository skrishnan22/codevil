import type { SqlStatement } from "../session-directory.js";

import {
  externalParticipantId,
  type ExternalSessionLinkRow,
  type IntegrationChannelRow,
  type IntegrationExternalActorRow,
  type IntegrationProvider,
  type IntegrationRow,
} from "./types.js";

export { externalParticipantId };

export function integrationId(provider: IntegrationProvider, externalWorkspaceId: string): string {
  return `int_${provider}_${externalWorkspaceId}`;
}

export function externalActorRowId(integrationIdValue: string, externalActorId: string): string {
  return `iea_${integrationIdValue}_${externalActorId}`;
}

export function integrationChannelRowId(integrationIdValue: string, externalChannelId: string): string {
  return `ich_${integrationIdValue}_${externalChannelId}`;
}

export function externalSessionLinkId(
  integrationIdValue: string,
  externalChannelId: string,
  externalConversationId: string,
): string {
  return `esl_${integrationIdValue}_${externalChannelId}_${externalConversationId}`;
}

export function upsertIntegration(row: IntegrationRow): SqlStatement {
  return {
    sql: `INSERT INTO integrations (
      id,
      provider,
      external_workspace_id,
      external_workspace_name,
      bot_external_actor_id,
      config_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, external_workspace_id) DO UPDATE SET
      external_workspace_name = excluded.external_workspace_name,
      bot_external_actor_id = excluded.bot_external_actor_id,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at`,
    bindings: [
      row.id,
      row.provider,
      row.external_workspace_id,
      row.external_workspace_name,
      row.bot_external_actor_id,
      row.config_json,
      row.created_at,
      row.updated_at,
    ],
  };
}

export function integrationByProviderWorkspaceSelect(
  provider: IntegrationProvider,
  externalWorkspaceId: string,
): SqlStatement {
  return {
    sql: "SELECT * FROM integrations WHERE provider = ? AND external_workspace_id = ?",
    bindings: [provider, externalWorkspaceId],
  };
}

export function upsertExternalActor(row: IntegrationExternalActorRow): SqlStatement {
  return {
    sql: `INSERT INTO integration_external_actors (
      id,
      integration_id,
      external_actor_id,
      display_name,
      email,
      linked_auth_user_id,
      metadata_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(integration_id, external_actor_id) DO UPDATE SET
      display_name = excluded.display_name,
      email = excluded.email,
      linked_auth_user_id = COALESCE(integration_external_actors.linked_auth_user_id, excluded.linked_auth_user_id),
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at`,
    bindings: [
      row.id,
      row.integration_id,
      row.external_actor_id,
      row.display_name,
      row.email,
      row.linked_auth_user_id,
      row.metadata_json,
      row.created_at,
      row.updated_at,
    ],
  };
}

export function upsertChannelDefaultRepo(row: IntegrationChannelRow): SqlStatement {
  return {
    sql: `INSERT INTO integration_channels (
      id,
      integration_id,
      external_channel_id,
      display_name,
      default_repo_url,
      metadata_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(integration_id, external_channel_id) DO UPDATE SET
      display_name = excluded.display_name,
      default_repo_url = excluded.default_repo_url,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at`,
    bindings: [
      row.id,
      row.integration_id,
      row.external_channel_id,
      row.display_name,
      row.default_repo_url,
      row.metadata_json,
      row.created_at,
      row.updated_at,
    ],
  };
}

export function channelByExternalIdSelect(integrationIdValue: string, externalChannelId: string): SqlStatement {
  return {
    sql: "SELECT * FROM integration_channels WHERE integration_id = ? AND external_channel_id = ?",
    bindings: [integrationIdValue, externalChannelId],
  };
}

export function clearChannelDefaultRepoUpdate(
  integrationIdValue: string,
  externalChannelId: string,
  updatedAt: string,
): SqlStatement {
  return {
    sql: `UPDATE integration_channels
      SET default_repo_url = NULL, updated_at = ?
      WHERE integration_id = ? AND external_channel_id = ?`,
    bindings: [updatedAt, integrationIdValue, externalChannelId],
  };
}

export function externalSessionLinkInsert(row: ExternalSessionLinkRow): SqlStatement {
  return {
    sql: `INSERT INTO external_session_links (
      id,
      integration_id,
      external_channel_id,
      external_conversation_id,
      session_id,
      last_handled_message_id,
      created_by_external_actor_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      row.id,
      row.integration_id,
      row.external_channel_id,
      row.external_conversation_id,
      row.session_id,
      row.last_handled_message_id,
      row.created_by_external_actor_id,
      row.created_at,
      row.updated_at,
    ],
  };
}

export function externalSessionLinkSelect(
  integrationIdValue: string,
  externalChannelId: string,
  externalConversationId: string,
): SqlStatement {
  return {
    sql: `SELECT * FROM external_session_links
      WHERE integration_id = ? AND external_channel_id = ? AND external_conversation_id = ?`,
    bindings: [integrationIdValue, externalChannelId, externalConversationId],
  };
}

export function externalSessionLinkHandledUpdate(
  linkId: string,
  lastHandledMessageId: string,
  updatedAt: string,
): SqlStatement {
  return {
    sql: `UPDATE external_session_links
      SET last_handled_message_id = ?, updated_at = ?
      WHERE id = ?`,
    bindings: [lastHandledMessageId, updatedAt, linkId],
  };
}

export function externalSessionLinkBySessionSelect(sessionId: string): SqlStatement {
  return {
    sql: "SELECT * FROM external_session_links WHERE session_id = ?",
    bindings: [sessionId],
  };
}

export function dedupeEventInsert(
  externalEventId: string,
  integrationIdValue: string | null,
  externalMessageId: string | null,
  handledAt: string,
): SqlStatement {
  return {
    sql: `INSERT OR IGNORE INTO external_message_dedupe (
      id,
      integration_id,
      external_event_id,
      external_message_id,
      handled_at
    ) VALUES (?, ?, ?, ?, ?)`,
    bindings: [`emd_${externalEventId}`, integrationIdValue, externalEventId, externalMessageId, handledAt],
  };
}
