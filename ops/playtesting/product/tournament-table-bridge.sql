-- Match completion is staged by XMage independently of per-game replay uploads.
CREATE TABLE IF NOT EXISTS tournament_engine_results (
  pairing_id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  seat_a text NOT NULL,
  seat_b text NOT NULL,
  wins_a integer NOT NULL CHECK (wins_a >= 0),
  wins_b integer NOT NULL CHECK (wins_b >= 0),
  draws integer NOT NULL CHECK (draws >= 0),
  disqualified text
);

ALTER TABLE tournament_engine_results ADD COLUMN IF NOT EXISTS winner_engine_name text;
ALTER TABLE tournament_engine_results ADD COLUMN IF NOT EXISTS match_id uuid;

-- Restored table IDs may change several times. The checkpoint always names the first table.
ALTER TABLE tournament_pairings ADD COLUMN IF NOT EXISTS original_engine_table_id uuid;
CREATE INDEX IF NOT EXISTS tournament_pairings_original_engine_idx ON tournament_pairings(original_engine_table_id)
  WHERE original_engine_table_id IS NOT NULL;
