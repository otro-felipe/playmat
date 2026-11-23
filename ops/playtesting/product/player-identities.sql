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

-- Existing reservations predate the RPC boundary and may already be in XMage.
ALTER TABLE player_table_reservations
  ADD COLUMN IF NOT EXISTS started boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS cancel_pending boolean NOT NULL DEFAULT false;
ALTER TABLE player_table_reservations ALTER COLUMN started SET DEFAULT false;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS cancel_pending boolean NOT NULL DEFAULT false;

-- Effective play seats are resolved afresh for every connection. An exact OAuth
-- seat always retains its identity. Only the canonical account grant can select
-- additional opted-in profiles owned by that account.
CREATE OR REPLACE VIEW playable_oauth_seats AS
  SELECT c.id AS connection_id, c.account_id, target.engine_key, target.player_id,
    target.engine_key <> source.engine_key AS delegated
  FROM oauth_connections c
  JOIN accounts a ON a.id=c.account_id AND a.enabled
  JOIN agent_grants source ON source.engine_key=c.engine_key AND source.account_id=c.account_id
    AND source.oauth_managed AND source.revoked_at IS NULL AND 'play'=ANY(source.scopes)
  JOIN agent_grants target ON target.account_id=c.account_id
    AND (target.engine_key=source.engine_key OR
      (source.player_id IS NULL AND source.engine_key='mcp_' || a.username_key AND target.player_id IS NOT NULL))
    AND target.oauth_managed AND target.revoked_at IS NULL AND 'play'=ANY(target.scopes)
  LEFT JOIN player_profiles p ON p.id=target.player_id AND p.account_id=c.account_id
  WHERE c.revoked_at IS NULL AND c.expires_at>now() AND 'play'=ANY(c.scopes_approved)
    AND (target.player_id IS NULL OR p.mcp_enabled);

-- Trusted account-addressed invitations may predate pregame sharing. Keep their public link
-- stable from discovery through assignment without naming or exposing a prospective guest.
INSERT INTO spectator_links(table_id,owner_id,token,public_host,live_table_id,table_name,hands_token)
SELECT i.table_id,h.account_id,
  translate(encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()),'base64'),'+/=','-_'),
  i.creator_key,i.table_id,i.table_name,CASE WHEN i.spectator_both_hands THEN
  translate(encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()),'base64'),'+/=','-_') END
FROM invitations i JOIN agent_grants h ON h.engine_key=i.creator_key
WHERE i.broadcast_on_assignment AND i.claimed_at IS NULL AND NOT i.cancel_pending AND i.expires_at>now()
  AND NOT EXISTS (SELECT 1 FROM spectator_links l WHERE l.table_id=i.table_id)
ON CONFLICT(table_id) DO NOTHING;
UPDATE invitations i SET spectator_settings_locked=true
WHERE NOT spectator_settings_locked AND (claimed_at IS NOT NULL OR EXISTS
  (SELECT 1 FROM player_table_reservations r JOIN agent_grants g ON g.player_id=r.player_id
   WHERE r.table_id=i.table_id AND g.engine_key<>i.creator_key AND
     (g.engine_key=i.invitee_key OR (i.invitee_key IS NULL AND g.account_id=i.recipient_account_id))));
