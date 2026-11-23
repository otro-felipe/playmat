ALTER TABLE accounts ADD COLUMN IF NOT EXISTS unlimited_match_history boolean NOT NULL DEFAULT false;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS history_cleared_through_ms bigint;

CREATE INDEX IF NOT EXISTS agent_grants_by_account_engine ON agent_grants(account_id, engine_key);

-- One quota per account, even when the account plays from different agent seats.
CREATE OR REPLACE VIEW match_history_retention_window AS
WITH account_seats AS (
  SELECT id AS account_id, username_key AS engine_key FROM accounts
  UNION ALL
  SELECT account_id, engine_key FROM agent_grants
), participation AS (
  SELECT DISTINCT s.account_id, g.match_id
  FROM account_seats s
  JOIN game_players p USING (engine_key)
  JOIN games g ON g.id=p.game_id
), position AS (
  SELECT p.account_id, p.match_id, m.status, (a.unlimited_match_history OR a.tournament_admin) AS unlimited_match_history,
    row_number() OVER (PARTITION BY p.account_id, (m.status='active') ORDER BY m.started_at DESC, m.id DESC) AS recent
  FROM participation p
  JOIN matches m ON m.id=p.match_id
  JOIN accounts a ON a.id=p.account_id
)
SELECT account_id, match_id FROM position
WHERE status='active' OR unlimited_match_history OR recent<=20;

-- Clearing a player's screen must not make a shared archive eligible for physical deletion.
CREATE OR REPLACE VIEW retained_match_history AS
SELECT w.account_id, w.match_id
FROM match_history_retention_window w
JOIN accounts a ON a.id=w.account_id
JOIN matches m ON m.id=w.match_id
WHERE a.history_cleared_through_ms IS NULL OR m.status='active'
   OR COALESCE(m.ended_at, m.started_at)>a.history_cleared_through_ms;

-- Prevent a late staging retry from restoring pruned match metadata.
CREATE TABLE IF NOT EXISTS purged_match_history (
  match_id uuid PRIMARY KEY
);

-- Delete objects after the PostgreSQL transaction commits and in-flight reads have had time to finish.
CREATE TABLE IF NOT EXISTS replay_object_deletions (
  object_key text PRIMARY KEY,
  available_at timestamptz NOT NULL DEFAULT now() + interval '2 minutes'
);
CREATE INDEX IF NOT EXISTS replay_object_deletions_available ON replay_object_deletions(available_at);
