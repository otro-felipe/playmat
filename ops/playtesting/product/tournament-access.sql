ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tournament_admin boolean NOT NULL DEFAULT false;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS owner_player_id uuid REFERENCES player_profiles(id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='decks'::regclass AND conname='deck_private_owner') THEN
    ALTER TABLE decks DROP CONSTRAINT IF EXISTS decks_library_check;
    ALTER TABLE decks ADD CONSTRAINT deck_private_owner CHECK
      ((library='private' AND owner_player_id IS NOT NULL) OR
       (library IN ('personal','agent') AND owner_player_id IS NULL));
  END IF;
END $$;
