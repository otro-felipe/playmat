CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY,
  username text NOT NULL,
  username_key text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT TRUE
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email text;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_verified_email ON accounts(email);

CREATE TABLE IF NOT EXISTS signup_links (
  email text PRIMARY KEY,
  token_digest text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS signup_links_expiration ON signup_links(expires_at);

CREATE TABLE IF NOT EXISTS browser_sessions (
  digest text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS player_profiles (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  flag text CHECK (flag ~ '^[A-Z]{2}$'),
  mcp_enabled boolean NOT NULL DEFAULT false,
  UNIQUE (account_id,id)
);

CREATE TABLE IF NOT EXISTS agent_grants (
  digest text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  engine_name text NOT NULL,
  engine_key text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS oauth_managed boolean NOT NULL DEFAULT false;
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS recovery_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS agent_grants_recovery_id ON agent_grants(recovery_id);
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS player_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_grants'::regclass AND conname='agent_grants_profile_owner') THEN
    ALTER TABLE agent_grants ADD CONSTRAINT agent_grants_profile_owner
      FOREIGN KEY (account_id,player_id) REFERENCES player_profiles(account_id,id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS agent_grants_profile ON agent_grants(player_id) WHERE player_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_grants_default_oauth ON agent_grants(account_id)
  WHERE oauth_managed AND revoked_at IS NULL AND player_id IS NULL;
DROP INDEX IF EXISTS agent_grants_account_oauth;

CREATE TABLE IF NOT EXISTS decks (
  account_id uuid NOT NULL REFERENCES accounts(id),
  id text NOT NULL,
  head integer NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL DEFAULT 0,
  removed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS deck_revisions (
  account_id uuid NOT NULL,
  deck_id text NOT NULL,
  revision integer NOT NULL,
  name text NOT NULL,
  format text NOT NULL CONSTRAINT deck_revisions_library_format_check CHECK (char_length(format) BETWEEN 1 AND 120),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (account_id, deck_id, revision),
  FOREIGN KEY (account_id, deck_id) REFERENCES decks(account_id, id)
);

-- Legacy decks remain personal until the owner explicitly moves them. No name-based inference.
ALTER TABLE decks ADD COLUMN IF NOT EXISTS library text NOT NULL DEFAULT 'personal'
  CHECK (library IN ('personal', 'agent'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'deck_revisions'::regclass AND conname = 'deck_revisions_library_format_check') THEN
    ALTER TABLE deck_revisions
      DROP CONSTRAINT IF EXISTS deck_revisions_format_check,
      ADD CONSTRAINT deck_revisions_library_format_check CHECK (char_length(format) BETWEEN 1 AND 120);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS deck_revision_cards (
  account_id uuid NOT NULL,
  deck_id text NOT NULL,
  revision integer NOT NULL,
  zone text NOT NULL CHECK (zone IN ('cards', 'sideboard')),
  position integer NOT NULL,
  card_name text NOT NULL,
  set_code text,
  card_number text,
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 250),
  PRIMARY KEY (account_id, deck_id, revision, zone, position),
  FOREIGN KEY (account_id, deck_id, revision) REFERENCES deck_revisions(account_id, deck_id, revision)
);

CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  name text NOT NULL DEFAULT '',
  format text,
  wins_needed integer,
  started_at bigint NOT NULL,
  ended_at bigint,
  winner text,
  status text NOT NULL CHECK (status IN ('active', 'completed', 'interrupted'))
);

CREATE TABLE IF NOT EXISTS games (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches(id),
  game_number integer NOT NULL,
  started_at bigint NOT NULL,
  ended_at bigint,
  result text,
  winner text,
  start_player text,
  turns integer,
  events integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('active', 'completed', 'interrupted', 'abandoned')),
  archive_state text NOT NULL CHECK (archive_state IN ('pending', 'ready', 'partial')),
  object_key text,
  checksum text,
  truncated boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS game_players (
  game_id uuid NOT NULL REFERENCES games(id),
  engine_key text NOT NULL,
  engine_name text NOT NULL,
  human boolean NOT NULL,
  deck_snapshot jsonb,
  mulligans integer,
  PRIMARY KEY (game_id, engine_key)
);
ALTER TABLE game_players ADD COLUMN IF NOT EXISTS deck_signature text;

CREATE INDEX IF NOT EXISTS game_players_by_engine
  ON game_players(engine_key, game_id);
CREATE INDEX IF NOT EXISTS games_by_match
  ON games(match_id, game_number, id);
CREATE INDEX IF NOT EXISTS matches_by_date
  ON matches(started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS invitations (
  table_id uuid PRIMARY KEY,
  room_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('Standard','Pioneer','Modern')),
  creator_key text NOT NULL,
  invitee_key text NOT NULL,
  invitee_name text NOT NULL,
  table_password text NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz
);
CREATE INDEX IF NOT EXISTS invitations_by_invitee ON invitations(invitee_key, expires_at DESC);

ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'friend' CHECK (mode IN ('friend', 'mcp')),
  ADD COLUMN IF NOT EXISTS unlisted boolean NOT NULL DEFAULT false CHECK (NOT unlisted OR mode='friend'),
  ADD COLUMN IF NOT EXISTS guest_display_name text,
  ADD COLUMN IF NOT EXISTS chat_mode text NOT NULL DEFAULT 'quiet' CHECK (chat_mode IN ('quiet', 'chatty', 'coach')),
  ADD COLUMN IF NOT EXISTS owner_account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  ALTER COLUMN invitee_key DROP NOT NULL,
  ALTER COLUMN invitee_name DROP NOT NULL;

CREATE INDEX IF NOT EXISTS invitations_by_owner ON invitations(owner_account_id, expires_at DESC)
  WHERE owner_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS replay_exports (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  engine_key text NOT NULL,
  game_ids uuid[] NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_event_subscriptions (
  id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  engine_key text NOT NULL REFERENCES agent_grants(engine_key),
  connection_id uuid,
  event_name text NOT NULL CHECK (event_name IN ('game.invitation.created', 'game.decision.required')),
  game_filter uuid,
  callback_url text NOT NULL,
  secret bytea NOT NULL,
  previous_secret bytea,
  previous_secret_until timestamptz,
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_event_subscriptions_by_recipient
  ON mcp_event_subscriptions(account_id, engine_key, event_name, expires_at);

CREATE TABLE IF NOT EXISTS mcp_events (
  id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  engine_key text NOT NULL REFERENCES agent_grants(engine_key),
  event_name text NOT NULL,
  event_key text NOT NULL,
  table_id uuid,
  format text,
  game_id uuid,
  decision_id text,
  cursor bigint,
  kind text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (account_id, engine_key, event_name, event_key),
  CHECK (
    (event_name = 'game.invitation.created' AND table_id IS NOT NULL AND format IS NOT NULL AND format IN ('Standard', 'Pioneer', 'Modern')
      AND game_id IS NULL AND decision_id IS NULL AND cursor IS NULL AND kind IS NULL)
    OR
    (event_name = 'game.decision.required' AND game_id IS NOT NULL AND decision_id IS NOT NULL AND cursor IS NOT NULL AND cursor >= 0
      AND kind IS NOT NULL AND table_id IS NULL AND format IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS mcp_events_expiry ON mcp_events(expires_at);

CREATE TABLE IF NOT EXISTS mcp_event_deliveries (
  event_id text NOT NULL REFERENCES mcp_events(id) ON DELETE CASCADE,
  subscription_id text NOT NULL REFERENCES mcp_event_subscriptions(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  PRIMARY KEY (event_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS mcp_event_deliveries_pending
  ON mcp_event_deliveries(available_at, lease_until);

-- The policy belongs to the original table and applies to every game of its match.
CREATE TABLE IF NOT EXISTS human_match_seats (
  table_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  allowed boolean NOT NULL,
  created_via_mcp boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE human_match_seats ADD COLUMN IF NOT EXISTS restored_from uuid;

CREATE TABLE IF NOT EXISTS spectator_links (
  table_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ordinary browser broadcasts retain their existing sharing policy. Automatically
-- published MCP tables persist their expected seats and the current engine table.
ALTER TABLE spectator_links
  ADD COLUMN IF NOT EXISTS public_host text,
  ADD COLUMN IF NOT EXISTS public_guest text,
  ADD COLUMN IF NOT EXISTS table_name text,
  ADD COLUMN IF NOT EXISTS live_table_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS spectator_live_table ON spectator_links(live_table_id) WHERE live_table_id IS NOT NULL;
