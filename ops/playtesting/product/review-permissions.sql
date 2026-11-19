CREATE TABLE IF NOT EXISTS replay_review_captures (
  match_id uuid PRIMARY KEY,
  table_id uuid NOT NULL UNIQUE,
  review_version smallint CHECK (review_version > 0),
  sealed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replay_review_capture_seats (
  match_id uuid NOT NULL REFERENCES replay_review_captures(match_id),
  engine_key text NOT NULL,
  account_id uuid REFERENCES accounts(id),
  human boolean NOT NULL,
  PRIMARY KEY (match_id, engine_key)
);
