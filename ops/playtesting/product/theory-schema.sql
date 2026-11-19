CREATE TABLE IF NOT EXISTS theory_studies (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  request_id uuid,
  request_hash text NOT NULL,
  game_id uuid REFERENCES games(id) ON DELETE CASCADE,
  archive_revision text,
  event_cursor integer CHECK (event_cursor >= 0),
  seat_key text,
  -- The versioned aggregate report has model-dependent metrics. Inputs and samples are not stored.
  result jsonb NOT NULL,
  UNIQUE (account_id, request_id),
  CHECK (num_nonnulls(game_id, archive_revision, event_cursor, seat_key) IN (0, 4))
);

CREATE INDEX IF NOT EXISTS theory_studies_by_annotation
  ON theory_studies(account_id, game_id, archive_revision, event_cursor, seat_key)
  WHERE game_id IS NOT NULL;
