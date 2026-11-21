import { archetypesFor, classifyArchetype, deckListSignature } from './deck-performance-identity.mjs'
import { transaction } from './decks.mjs'

// Run atomically with the library locked. Other replicas either see the old storage
// or every revision together, including the head with its original optimistic token.
export async function migrateDeckLists(pool) {
  return transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('deck-list-identity-v1'))")
    const { rowCount: ready } = await db.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='deck_revisions'
      AND column_name IN ('list_version','list_signature','archetype') AND is_nullable='NO'`)
    if (ready === 3) return
    await db.query(`ALTER TABLE deck_revisions ADD COLUMN IF NOT EXISTS list_version integer,
      ADD COLUMN IF NOT EXISTS list_signature text, ADD COLUMN IF NOT EXISTS archetype text`)
    const { rows: families } = await db.query('SELECT account_id, id FROM decks ORDER BY account_id, id')
    for (const { account_id: account, id } of families) {
      const { rows: revisions } = await db.query(`SELECT revision, format, name, metadata->>'archetype' AS prior_label
        FROM deck_revisions WHERE account_id=$1 AND deck_id=$2 ORDER BY revision`, [account, id])
      const { rows: cards } = await db.query(`SELECT revision, zone, card_name AS "cardName", amount FROM deck_revision_cards
        WHERE account_id=$1 AND deck_id=$2 ORDER BY revision`, [account, id])
      const lists = new Map(revisions.map(row => [row.revision, { cards: [], sideboard: [] }]))
      for (const { revision, zone, ...card } of cards) lists.get(revision)[zone].push(card)
      const versions = new Map()
      let lastLabel
      for (const row of revisions) {
        const deck = lists.get(row.revision)
        const signature = deckListSignature(deck)
        if (!versions.has(signature)) versions.set(signature, versions.size + 1)
        const labels = archetypesFor(row.format)
        let archetype = classifyArchetype(row.format, row.name, deck.cards)
        if (labels.includes(row.prior_label)) archetype = row.prior_label
        else if (archetype === 'Other' && labels.includes(lastLabel)) archetype = lastLabel
        lastLabel = archetype
        await db.query(`UPDATE deck_revisions SET list_version=$4, list_signature=$5, archetype=$6
          WHERE account_id=$1 AND deck_id=$2 AND revision=$3`, [account, id, row.revision, versions.get(signature), signature, archetype])
      }
      // Browsers compare timestamps to decide whether new server metadata needs downloading.
      await db.query('UPDATE decks SET updated_at=updated_at+1 WHERE account_id=$1 AND id=$2', [account, id])
    }
    await db.query(`ALTER TABLE deck_revisions ALTER COLUMN list_version SET NOT NULL,
      ALTER COLUMN list_signature SET NOT NULL, ALTER COLUMN archetype SET NOT NULL`)
    await db.query('CREATE INDEX IF NOT EXISTS deck_revision_signature ON deck_revisions(account_id, deck_id, list_signature, revision DESC)')
  })
}

/** Deployment evidence contains counts alone, across both library shelves. */
export async function libraryArchetypeCoverage(db) {
  const { rows: [counts] } = await db.query(`SELECT COUNT(*)::integer AS "currentDecks",
    COUNT(*) FILTER (WHERE r.archetype <> '')::integer AS "classifiedDecks",
    COUNT(*) FILTER (WHERE r.archetype = 'Other')::integer AS "otherDecks",
    (SELECT COUNT(*)::integer FROM deck_revisions WHERE archetype <> '') AS "classifiedRevisions"
    FROM decks d LEFT JOIN deck_revisions r
      ON (d.account_id,d.id,d.head) = (r.account_id,r.deck_id,r.revision)
    WHERE NOT d.removed`)
  return counts
}
