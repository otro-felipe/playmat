-- A table seat submits one starting list. The public matchup attribute is
-- intentionally separate from the player's private saved list and revision.
CREATE TABLE IF NOT EXISTS match_deck_registrations (
  table_id uuid NOT NULL,
  engine_key text NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  deck_id text NOT NULL,
  list_version integer NOT NULL CHECK (list_version > 0),
  list_signature text NOT NULL,
  archetype text,
  deck_name text NOT NULL,
  PRIMARY KEY (table_id, engine_key)
);

-- The source replay is immutable once its checksum is committed. These rows
-- contain only evidence available to the seat, and follow archive retention.
CREATE TABLE IF NOT EXISTS game_performance_evidence (
  game_id uuid NOT NULL,
  engine_key text NOT NULL,
  kept_hand_known boolean NOT NULL,
  opponent_view_known boolean NOT NULL,
  PRIMARY KEY (game_id, engine_key),
  FOREIGN KEY (game_id, engine_key) REFERENCES game_players(game_id, engine_key) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS game_performance_cards (
  game_id uuid NOT NULL,
  engine_key text NOT NULL,
  evidence text NOT NULL CHECK (evidence IN ('keep', 'opponent')),
  card_name text NOT NULL,
  PRIMARY KEY (game_id, engine_key, evidence, card_name),
  FOREIGN KEY (game_id, engine_key) REFERENCES game_performance_evidence(game_id, engine_key) ON DELETE CASCADE
);

ALTER TABLE game_players ADD COLUMN IF NOT EXISTS archetype text;

CREATE TABLE IF NOT EXISTS match_statistics_exclusions (
  match_id uuid PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  author text NOT NULL,
  author_account_id uuid REFERENCES accounts(id),
  marked_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW statistically_eligible_matches AS
SELECT m.* FROM matches m
WHERE m.status='completed' AND NOT EXISTS (
  SELECT 1 FROM match_statistics_exclusions x WHERE x.match_id=m.id
);
