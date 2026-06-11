CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE sessions ADD COLUMN created_by_user_id TEXT;
ALTER TABLE sessions ADD COLUMN created_by_name TEXT;
ALTER TABLE sessions ADD COLUMN created_by_email TEXT;

CREATE INDEX IF NOT EXISTS idx_memberships_role_status
  ON memberships(role, status);

CREATE INDEX IF NOT EXISTS idx_invitations_email_pending
  ON invitations(email, accepted_at, revoked_at, expires_at);
