-- Competition records outlive per-account match and object-store retention.
CREATE TABLE IF NOT EXISTS tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, format text NOT NULL,
  organizer_id uuid NOT NULL REFERENCES accounts(id), template text NOT NULL, cut text NOT NULL,
  capacity integer NOT NULL, requested_rounds integer, swiss_best_of integer NOT NULL,
  playoff_best_of integer NOT NULL, max_agents_per_owner integer NOT NULL, coaching boolean NOT NULL,
  break_minutes integer NOT NULL, created_at bigint NOT NULL,
  status text NOT NULL DEFAULT 'registration', stage text NOT NULL DEFAULT 'registration',
  round_number integer NOT NULL DEFAULT 0, rounds_total integer NOT NULL DEFAULT 0,
  cut_size integer NOT NULL DEFAULT 0, deadline_at bigint, next_round_at bigint,
  next_session_at bigint, champion_id uuid
);
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS creation_request_id uuid;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS creation_request_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS tournament_creation_request ON tournaments(organizer_id,creation_request_id)
  WHERE creation_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tournament_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid NOT NULL REFERENCES tournaments(id),
  owner_id uuid NOT NULL REFERENCES accounts(id), player_id uuid REFERENCES player_profiles(id),
  name text NOT NULL, owner_name text NOT NULL, engine_name text NOT NULL, deck_id text NOT NULL,
  deck_revision integer NOT NULL, deck_name text NOT NULL, seed integer NOT NULL DEFAULT 0,
  last_seen bigint, state text NOT NULL DEFAULT 'registered', qualified_seed integer,
  UNIQUE(tournament_id, engine_name)
);
CREATE INDEX IF NOT EXISTS tournament_entries_owner ON tournament_entries(owner_id);
CREATE TABLE IF NOT EXISTS tournament_entry_cards (
  entry_id uuid NOT NULL REFERENCES tournament_entries(id), zone text NOT NULL, position integer NOT NULL,
  card_name text NOT NULL, amount integer NOT NULL, set_code text, card_number text,
  PRIMARY KEY(entry_id,zone,position)
);
CREATE TABLE IF NOT EXISTS tournament_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid NOT NULL REFERENCES tournaments(id),
  round_number integer NOT NULL, stage text NOT NULL, number integer NOT NULL, best_of integer NOT NULL,
  entry_a uuid NOT NULL REFERENCES tournament_entries(id),entry_b uuid REFERENCES tournament_entries(id),winner_entry uuid REFERENCES tournament_entries(id),
  table_id uuid UNIQUE, match_id uuid, deadline_at bigint, opened_at bigint NOT NULL,
  wins_a integer NOT NULL DEFAULT 0, wins_b integer NOT NULL DEFAULT 0, draws integer NOT NULL DEFAULT 0,
  completed boolean NOT NULL DEFAULT false, cleanup_done boolean NOT NULL DEFAULT false, result_reason text, ack_a bigint, ack_b bigint,
  UNIQUE(tournament_id,round_number,number)
);
ALTER TABLE tournament_pairings ADD COLUMN IF NOT EXISTS launched boolean NOT NULL DEFAULT false;
ALTER TABLE tournament_pairings ADD COLUMN IF NOT EXISTS launch_requested_at bigint;
ALTER TABLE tournament_pairings ADD COLUMN IF NOT EXISTS attendance_elapsed_ms bigint NOT NULL DEFAULT 0;
ALTER TABLE tournament_pairings ADD COLUMN IF NOT EXISTS attendance_observed_at bigint;
CREATE INDEX IF NOT EXISTS tournament_pending_tables ON tournament_pairings(tournament_id) WHERE NOT completed;

-- History and matchup statistics must apply tournament publication timing
-- even after an individual match has finished.
CREATE OR REPLACE VIEW published_tournament_entries AS
SELECT e.id AS entry_id FROM tournament_entries e JOIN tournaments t ON t.id=e.tournament_id
WHERE e.state<>'absent' AND (t.status='finished' OR (t.stage='playoffs' AND e.qualified_seed IS NOT NULL));

ALTER TABLE tournament_pairings ADD COLUMN IF NOT EXISTS original_engine_table_id uuid;

-- Every physical incarnation points to one competition match, including tables
-- on which a replay was captured between two checkpoint recoveries.
CREATE TABLE IF NOT EXISTS tournament_pairing_tables (
  table_id uuid PRIMARY KEY, pairing_id uuid NOT NULL REFERENCES tournament_pairings(id) ON DELETE CASCADE
);
ALTER TABLE tournament_pairing_tables ADD COLUMN IF NOT EXISTS failed_start_retried_at bigint;
CREATE INDEX IF NOT EXISTS tournament_pairing_tables_pair ON tournament_pairing_tables(pairing_id);
CREATE OR REPLACE FUNCTION remember_tournament_pairing_table() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tournament_pairing_tables(table_id,pairing_id)
    SELECT DISTINCT t,NEW.id FROM unnest(ARRAY[NEW.table_id,NEW.original_engine_table_id]) t WHERE t IS NOT NULL
    ON CONFLICT(table_id) DO NOTHING;
  IF EXISTS (SELECT 1 FROM tournament_pairing_tables
             WHERE table_id IN (NEW.table_id,NEW.original_engine_table_id) AND pairing_id<>NEW.id) THEN
    RAISE EXCEPTION 'Engine table already belongs to a tournament pairing';
  END IF;
  RETURN NULL;
END
$$;
CREATE OR REPLACE TRIGGER remember_tournament_pairing_table
AFTER INSERT OR UPDATE OF table_id,original_engine_table_id ON tournament_pairings
FOR EACH ROW EXECUTE FUNCTION remember_tournament_pairing_table();
INSERT INTO tournament_pairing_tables(table_id,pairing_id)
  SELECT DISTINCT t,p.id FROM tournament_pairings p CROSS JOIN LATERAL unnest(ARRAY[p.table_id,p.original_engine_table_id]) t
  WHERE t IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tournament_pairing_tables seen WHERE seen.table_id=t)
  ON CONFLICT(table_id) DO NOTHING;
CREATE OR REPLACE FUNCTION tournament_pairing_for_table(match_table uuid) RETURNS uuid LANGUAGE sql STABLE STRICT AS $$
  SELECT pairing_id FROM tournament_pairing_tables WHERE table_id=match_table
$$;
CREATE OR REPLACE FUNCTION match_deck_published(match_table uuid,seat_key text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM tournament_pairings p WHERE p.id=tournament_pairing_for_table(match_table)
      AND NOT EXISTS (SELECT 1 FROM tournament_entries e JOIN published_tournament_entries visible ON visible.entry_id=e.id
        WHERE e.id IN (p.entry_a,p.entry_b) AND lower(e.engine_name)=seat_key)
  )
$$;
