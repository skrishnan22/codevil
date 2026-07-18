export type IntegrationProvider = "slack";

export interface IntegrationRow {
  id: string;
  provider: IntegrationProvider;
  external_workspace_id: string;
  external_workspace_name: string | null;
  bot_external_actor_id: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface IntegrationExternalActorRow {
  id: string;
  integration_id: string;
  external_actor_id: string;
  display_name: string;
  email: string | null;
  linked_auth_user_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface IntegrationChannelRow {
  id: string;
  integration_id: string;
  external_channel_id: string;
  display_name: string | null;
  default_repo_url: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface ExternalSessionLinkRow {
  id: string;
  integration_id: string;
  external_channel_id: string;
  external_conversation_id: string;
  session_id: string;
  last_handled_message_id: string;
  created_by_external_actor_id: string;
  created_at: string;
  updated_at: string;
}

export interface ExternalConversationRef {
  provider: IntegrationProvider;
  integration_id: string;
  external_channel_id: string;
  external_conversation_id: string;
}

export interface ExternalConversationDestination extends ExternalConversationRef {
  session_id: string;
}

export function externalParticipantId(provider: IntegrationProvider, externalActorId: string): string {
  return `external:${provider}:${externalActorId}`;
}
