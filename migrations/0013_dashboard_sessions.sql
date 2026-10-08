CREATE TABLE IF NOT EXISTS dashboard_access_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  dashboard_id TEXT NOT NULL,
  account_session_token TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ticket', 'session')),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_access_expiry
  ON dashboard_access_tokens(expires_at);
