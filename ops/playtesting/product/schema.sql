CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY,
  username text NOT NULL,
  username_key text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  digest text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  expires_at timestamptz NOT NULL
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
  format text NOT NULL CHECK (format IN ('Standard', 'Pioneer', 'Modern')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (account_id, deck_id, revision),
  FOREIGN KEY (account_id, deck_id) REFERENCES decks(account_id, id)
);

CREATE TABLE IF NOT EXISTS deck_revision_cards (
  account_id uuid NOT NULL,
  deck_id text NOT NULL,
  revision integer NOT NULL,
  zone text NOT NULL CHECK (zone IN ('cards', 'sideboard')),
  position integer NOT NULL,
  entry jsonb NOT NULL,
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

CREATE TABLE IF NOT EXISTS replay_exports (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  engine_key text NOT NULL,
  game_ids uuid[] NOT NULL,
  expires_at timestamptz NOT NULL
);
