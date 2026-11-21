import { archetypesFor, basicLandNames, classifyArchetype, deckListSignature, publicListArchetype, verifiedListArchetype } from './deck-performance-identity.mjs'
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
        let archetype = classifyArchetype(row.format, row.name, deck.cards, deck.sideboard)
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

/** v1 issued its column DDL and rewrote every migrated revision in one transaction.
 * An explicit save made afterward has a different xmin. A restore, freeze, or
 * unknown provenance must leave Other intact.
 */
export async function refineMigratedDeckLists(pool) {
  return transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('deck-list-refinement-v2'))")
    const { rowCount } = await db.query(`SELECT 1 FROM pg_attribute WHERE attrelid='deck_revisions'::regclass
      AND attname='archetype_inferred' AND NOT attisdropped`)
    if (rowCount) return
    await db.query('LOCK TABLE decks, deck_revisions IN ACCESS EXCLUSIVE MODE')
    await db.query('ALTER TABLE deck_revisions ADD COLUMN archetype_inferred boolean NOT NULL DEFAULT FALSE')
    const { rows } = await db.query(`WITH original_migration AS (
      SELECT a.xmin AS writer FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid
      WHERE t.oid='deck_revisions'::regclass AND a.attname='archetype'
        AND age(a.xmin) BETWEEN 1 AND least(age(t.relfrozenxid), age((SELECT datfrozenxid FROM pg_database WHERE datname=current_database())))
        AND EXISTS (SELECT 1 FROM pg_attribute old WHERE old.attrelid=t.oid AND old.attname='name' AND old.xmin<>a.xmin)
        AND (SELECT count(*) FROM pg_attribute sibling WHERE sibling.attrelid=t.oid
          AND sibling.attname IN ('list_signature','list_version') AND sibling.xmin=a.xmin)=2
    )
    UPDATE deck_revisions r SET archetype_inferred=TRUE FROM original_migration m
    WHERE r.xmin=m.writer AND r.archetype='Other'
      AND NOT EXISTS (SELECT 1 FROM deck_revisions earlier WHERE earlier.account_id=r.account_id
        AND earlier.deck_id=r.deck_id AND earlier.revision<=r.revision AND earlier.metadata->>'archetype'='Other')
    RETURNING r.account_id,r.deck_id,r.revision,r.format,r.name,r.list_signature`)
    for (const row of rows) {
      const key = [row.account_id, row.deck_id, row.revision]
      let label = publicListArchetype(row.format, row.list_signature)
      if (!label) {
        const { rows: entries } = await db.query(`SELECT zone,card_name AS "cardName",amount FROM deck_revision_cards
          WHERE account_id=$1 AND deck_id=$2 AND revision=$3`, key)
        const deck = { cards: [], sideboard: [] }
        for (const entry of entries) deck[entry.zone].push(entry)
        label = verifiedListArchetype(row.format, row.name, deck.cards, deck.sideboard)
      }
      if (!label) continue
      await db.query('UPDATE deck_revisions SET archetype=$4 WHERE account_id=$1 AND deck_id=$2 AND revision=$3', [...key, label])
      await db.query('UPDATE decks SET updated_at=updated_at+1 WHERE account_id=$1 AND id=$2 AND head=$3', key)
    }
  })
}

/** Deployment evidence contains counts alone, across both library shelves. */
export async function libraryArchetypeCoverage(db) {
  const { rows: [counts] } = await db.query(`WITH heads AS (
    SELECT r.archetype, CASE
      WHEN r.archetype IS DISTINCT FROM 'Other' THEN NULL
      WHEN c.total=0 THEN 'empty'
      WHEN c.main_count<40 THEN 'incomplete'
      WHEN c.basic_only THEN 'basicOnly'
      ELSE 'complete' END AS shape
    FROM decks d LEFT JOIN deck_revisions r ON (d.account_id,d.id,d.head) = (r.account_id,r.deck_id,r.revision)
    LEFT JOIN LATERAL (SELECT coalesce(sum(amount),0) AS total,
      coalesce(sum(amount) FILTER (WHERE zone='cards'),0) AS main_count,
      bool_and(lower(trim(card_name))=ANY($1::text[])) AS basic_only
      FROM deck_revision_cards WHERE account_id=d.account_id AND deck_id=d.id AND revision=d.head) c ON r.archetype='Other'
    WHERE NOT d.removed
  ) SELECT COUNT(*)::integer AS "currentDecks",
    COUNT(*) FILTER (WHERE archetype <> 'Other')::integer AS "classifiedDecks",
    COUNT(*) FILTER (WHERE archetype='Other')::integer AS "otherDecks",
    (SELECT COUNT(*)::integer FROM deck_revisions WHERE archetype <> 'Other') AS "classifiedRevisions",
    json_build_object(
      'empty', count(*) FILTER (WHERE shape='empty'), 'basicOnly', count(*) FILTER (WHERE shape='basicOnly'),
      'incomplete', count(*) FILTER (WHERE shape='incomplete'), 'complete', count(*) FILTER (WHERE shape='complete')
    ) AS "otherBreakdown" FROM heads`, [basicLandNames])
  return counts
}

/** Revisit machine defaults using source-backed composition. Keep every explicitly chosen label and list version. */
export async function refineTournamentArchetypes(db) {
  const { rows } = await db.query(`SELECT account_id,deck_id,revision,format,name,list_signature FROM deck_revisions
    WHERE archetype_inferred AND archetype IN ('Other','Aggro','Combo','Control','Midrange','Ramp','Tempo') ORDER BY account_id,deck_id,revision`)
  for (const row of rows) {
    const key = [row.account_id,row.deck_id,row.revision]
    const { rows: entries } = await db.query(`SELECT zone,card_name AS "cardName",amount FROM deck_revision_cards
      WHERE account_id=$1 AND deck_id=$2 AND revision=$3`, key)
    const deck = { cards: [], sideboard: [] }
    for (const entry of entries) deck[entry.zone].push(entry)
    const label = publicListArchetype(row.format, row.list_signature) ?? verifiedListArchetype(row.format, row.name, deck.cards, deck.sideboard)
    if (!label) continue
    await db.query('UPDATE deck_revisions SET archetype=$4 WHERE account_id=$1 AND deck_id=$2 AND revision=$3', [...key,label])
    await db.query('UPDATE decks SET updated_at=updated_at+1 WHERE account_id=$1 AND id=$2 AND head=$3', key)
    await db.query(`UPDATE match_deck_registrations SET archetype=$4 WHERE account_id=$1 AND deck_id=$2 AND list_signature=$3
      AND (archetype IS NULL OR archetype='Other')`, [row.account_id,row.deck_id,row.list_signature,label])
  }
}
