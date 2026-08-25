CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  code_verifier_ciphertext TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE connections ADD COLUMN access_token_ciphertext TEXT;
ALTER TABLE connections ADD COLUMN refresh_token_ciphertext TEXT;
ALTER TABLE connections ADD COLUMN token_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at);
