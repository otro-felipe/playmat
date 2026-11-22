-- A grant keeps its historical engine name reserved. The active grant and all
-- OAuth connections move together; a legacy human or manual grant wins a name collision.
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS successor_key text REFERENCES agent_grants(engine_key);

DO $$
DECLARE
  seat record;
  wanted text;
BEGIN
  FOR seat IN SELECT g.engine_key, g.account_id, g.scopes, g.recovery_id, a.username
    FROM agent_grants g JOIN accounts a ON a.id=g.account_id
    WHERE g.oauth_managed AND g.player_id IS NULL AND g.revoked_at IS NULL AND g.engine_key <> 'mcp_' || a.username_key
    ORDER BY g.account_id FOR UPDATE OF g
  LOOP
    wanted := lower('mcp_' || seat.username);
    IF EXISTS (SELECT 1 FROM accounts WHERE username_key=wanted)
        OR EXISTS (SELECT 1 FROM agent_grants WHERE engine_key=wanted) THEN CONTINUE; END IF;

    UPDATE agent_grants SET revoked_at=now(), recovery_id=gen_random_uuid() WHERE engine_key=seat.engine_key;
    INSERT INTO agent_grants(digest, account_id, engine_name, engine_key, scopes, recovery_id, oauth_managed)
      VALUES(gen_random_uuid()::text, seat.account_id, 'mcp_' || seat.username, wanted, seat.scopes, seat.recovery_id, true);
    UPDATE agent_grants SET successor_key=wanted WHERE engine_key=seat.engine_key;
    UPDATE oauth_connections SET engine_key=wanted WHERE engine_key=seat.engine_key;
    UPDATE oauth_authorization_codes SET engine_key=wanted WHERE engine_key=seat.engine_key;
    UPDATE mcp_event_subscriptions SET engine_key=wanted WHERE engine_key=seat.engine_key;
    UPDATE mcp_events SET engine_key=wanted WHERE engine_key=seat.engine_key;
    UPDATE replay_exports SET engine_key=wanted WHERE engine_key=seat.engine_key;
    UPDATE invitations SET invitee_key=wanted, invitee_name='mcp_' || seat.username
      WHERE claimed_at IS NULL AND invitee_key=seat.engine_key;
  END LOOP;
END $$;

ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS creator_model text,
  ADD COLUMN IF NOT EXISTS creator_effort text,
  ADD COLUMN IF NOT EXISTS guest_model text,
  ADD COLUMN IF NOT EXISTS guest_effort text;

ALTER TABLE game_players
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS reasoning_effort text;


CREATE TABLE IF NOT EXISTS player_table_reservations (
  player_id uuid PRIMARY KEY REFERENCES player_profiles(id),
  reservation_id uuid UNIQUE NOT NULL,
  connection_id uuid NOT NULL REFERENCES oauth_connections(id),
  table_id uuid,
  original_table_id uuid
);
CREATE INDEX IF NOT EXISTS player_reservations_table ON player_table_reservations(table_id);
