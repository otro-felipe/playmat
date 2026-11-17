CREATE TABLE IF NOT EXISTS oauth_registered_clients (
  client_id text PRIMARY KEY,
  metadata jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_registration_limits (
  hour timestamptz PRIMARY KEY,
  attempts integer NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_consent_requests (
  id uuid PRIMARY KEY,
  browser_session text NOT NULL REFERENCES browser_sessions(digest) ON DELETE CASCADE,
  code_challenge text NOT NULL,
  client_state text NOT NULL,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  audience text NOT NULL,
  scopes_requested text[] NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_consent_requests_expiry ON oauth_consent_requests(expires_at);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  digest text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  engine_key text NOT NULL REFERENCES agent_grants(engine_key),
  code_challenge text NOT NULL,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  audience text NOT NULL,
  scopes_approved text[] NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expiry ON oauth_authorization_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_connections (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  engine_key text NOT NULL REFERENCES agent_grants(engine_key),
  client_id text NOT NULL,
  audience text NOT NULL,
  scopes_approved text[] NOT NULL,
  refresh_digest text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_connections_expiry ON oauth_connections(expires_at);
CREATE INDEX IF NOT EXISTS oauth_connections_owner ON oauth_connections(account_id);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  digest text PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_expiry ON oauth_access_tokens(expires_at);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_connection ON oauth_access_tokens(connection_id);

-- Ask clients authorized for a manually chosen agent to reconnect to the account.
UPDATE oauth_connections c SET revoked_at=now()
FROM agent_grants g
WHERE c.engine_key=g.engine_key AND NOT g.oauth_managed AND c.revoked_at IS NULL;
