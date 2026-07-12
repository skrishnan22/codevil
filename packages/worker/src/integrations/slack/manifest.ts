const REQUIRED_BOT_SCOPES = [
  "app_mentions:read",
  "commands",
  "chat:write",
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "users:read",
] as const;

export function buildSlackManifest(workerOrigin: string): string {
  const origin = workerOrigin.replace(/\/+$/, "");
  const scopes = REQUIRED_BOT_SCOPES.map((scope) => `      - ${scope}`).join("\n");

  return `display_information:
  name: Codevil
features:
  bot_user:
    display_name: Codevil
    always_online: false
  slash_commands:
    - command: /codevil
      url: ${origin}/slack/commands
      description: Configure and invoke Codevil
      usage_hint: set-repo https://github.com/org/repo
      should_escape: false
oauth_config:
  scopes:
    bot:
${scopes}
settings:
  event_subscriptions:
    request_url: ${origin}/slack/events
    bot_events:
      - app_mention
  interactivity:
    is_enabled: false
  socket_mode_enabled: false
  org_deploy_enabled: false
  token_rotation_enabled: false
`;
}
