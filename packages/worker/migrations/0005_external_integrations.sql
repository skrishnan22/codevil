CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_workspace_id TEXT NOT NULL,
  external_workspace_name TEXT,
  bot_external_actor_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, external_workspace_id)
);

CREATE TABLE IF NOT EXISTS integration_external_actors (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  external_actor_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  linked_auth_user_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(integration_id, external_actor_id)
);

CREATE TABLE IF NOT EXISTS integration_channels (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  external_channel_id TEXT NOT NULL,
  display_name TEXT,
  default_repo_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(integration_id, external_channel_id)
);

CREATE TABLE IF NOT EXISTS external_session_links (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  external_channel_id TEXT NOT NULL,
  external_conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  last_handled_message_id TEXT NOT NULL,
  created_by_external_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(integration_id, external_channel_id, external_conversation_id)
);

CREATE TABLE IF NOT EXISTS external_message_dedupe (
  id TEXT PRIMARY KEY,
  integration_id TEXT,
  external_event_id TEXT NOT NULL,
  external_message_id TEXT,
  handled_at TEXT NOT NULL,
  UNIQUE(external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_integration_channels_lookup
  ON integration_channels(integration_id, external_channel_id);

CREATE INDEX IF NOT EXISTS idx_external_session_links_session
  ON external_session_links(session_id);
