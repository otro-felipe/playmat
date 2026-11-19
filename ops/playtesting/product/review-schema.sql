ALTER TABLE matches ADD COLUMN IF NOT EXISTS engine_format text;
ALTER TABLE games ADD COLUMN IF NOT EXISTS review_version integer;
ALTER TABLE games ADD COLUMN IF NOT EXISTS review_incomplete boolean NOT NULL DEFAULT false;
ALTER TABLE game_players ADD COLUMN IF NOT EXISTS player_id uuid;

CREATE TABLE IF NOT EXISTS review_annotations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id uuid NOT NULL,
  archive_revision text NOT NULL,
  event_cursor integer NOT NULL CHECK (event_cursor >= 0),
  frame_cursor integer NOT NULL CHECK (frame_cursor >= 0 AND frame_cursor <= event_cursor),
  seat_key text NOT NULL,
  reviewer_account_id uuid NOT NULL REFERENCES accounts(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  rubric_version integer NOT NULL,
  content_hash text NOT NULL,
  category text NOT NULL CHECK (category IN ('brilliant','best','good','acceptable','inaccuracy','blunder','equivalent','insufficient','unrated')),
  confidence text NOT NULL CHECK (confidence IN ('low','medium','high')),
  action_kind text NOT NULL,
  action_text text NOT NULL,
  action_card text,
  turn integer,
  evidence_basis text NOT NULL,
  frame_quality text NOT NULL DEFAULT 'preceding_snapshot',
  rationale text NOT NULL,
  benefit text NOT NULL,
  risk text NOT NULL,
  retrospective text,
  requires_full boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, archive_revision, seat_key, event_cursor),
  FOREIGN KEY (game_id, seat_key) REFERENCES game_players(game_id, engine_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS review_annotations_page
  ON review_annotations(game_id, archive_revision, event_cursor, seat_key);
ALTER TABLE review_annotations ADD COLUMN IF NOT EXISTS decision_evidence_cursor integer;
ALTER TABLE review_annotations ADD COLUMN IF NOT EXISTS decision_evidence_summary text;
ALTER TABLE review_annotations ADD COLUMN IF NOT EXISTS observed_through_cursor integer;
ALTER TABLE review_annotations ADD COLUMN IF NOT EXISTS opportunity_window text;
ALTER TABLE review_annotations ADD COLUMN IF NOT EXISTS opportunity_opening_cursor integer;

CREATE TABLE IF NOT EXISTS review_alternatives (
  annotation_id bigint NOT NULL REFERENCES review_annotations(id) ON DELETE CASCADE,
  position integer NOT NULL,
  line text NOT NULL,
  legality text NOT NULL CHECK (legality IN ('confirmed','conditional','unverified')),
  condition text,
  benefit text NOT NULL,
  risk text NOT NULL,
  PRIMARY KEY (annotation_id, position)
);

CREATE TABLE IF NOT EXISTS review_opponent_responses (
  annotation_id bigint NOT NULL REFERENCES review_annotations(id) ON DELETE CASCADE,
  position integer NOT NULL,
  line text NOT NULL,
  basis text NOT NULL CHECK (basis IN ('public_observed','plausible')),
  impact text NOT NULL,
  PRIMARY KEY (annotation_id, position)
);

CREATE TABLE IF NOT EXISTS review_sources (
  annotation_id bigint NOT NULL REFERENCES review_annotations(id) ON DELETE CASCADE,
  position integer NOT NULL,
  url text NOT NULL,
  source_date date NOT NULL,
  format text NOT NULL,
  applicability text NOT NULL,
  PRIMARY KEY (annotation_id, position)
);

CREATE TABLE IF NOT EXISTS review_position_coverage (
  game_id uuid NOT NULL,
  archive_revision text NOT NULL,
  seat_key text NOT NULL,
  eligible integer NOT NULL CHECK (eligible >= 0),
  PRIMARY KEY (game_id, archive_revision, seat_key),
  FOREIGN KEY (game_id, seat_key) REFERENCES game_players(game_id, engine_key) ON DELETE CASCADE
);
