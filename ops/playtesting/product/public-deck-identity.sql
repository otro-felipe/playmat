-- Only id is a public identifier. The equality key stays on the server.
CREATE TABLE IF NOT EXISTS public_deck_compositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  format text NOT NULL, list_signature text NOT NULL, public_name text,
  UNIQUE(format,list_signature)
);
ALTER TABLE game_players ADD COLUMN IF NOT EXISTS opening_composition_id uuid REFERENCES public_deck_compositions(id);
ALTER TABLE game_players ADD COLUMN IF NOT EXISTS opening_archetype text;
ALTER TABLE game_players ADD COLUMN IF NOT EXISTS opening_colors text[];
ALTER TABLE game_players ADD COLUMN IF NOT EXISTS opening_snapshot_used boolean NOT NULL DEFAULT false;
ALTER TABLE game_players ADD COLUMN IF NOT EXISTS opening_identity_resolved boolean NOT NULL DEFAULT false;
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS opening_composition_id uuid REFERENCES public_deck_compositions(id);
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS opening_archetype text;
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS opening_colors text[];
ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS opening_identity_resolved boolean NOT NULL DEFAULT false;
