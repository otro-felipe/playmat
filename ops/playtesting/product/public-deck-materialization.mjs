import { isId, transaction } from './decks.mjs'
import { deckListSignature } from './deck-performance-identity.mjs'
import { mainColors, normalizedDeckColors, resolveHistoricalDeck, statisticsFormat } from './public-deck-identity.mjs'

async function storeComposition(db, fact) {
  if (!fact.signature) return null
  const {
    rows: [row],
  } = await db.query(
    `
    INSERT INTO public_deck_compositions(format,list_signature,public_name) VALUES($1,$2,$3)
    ON CONFLICT(format,list_signature) DO UPDATE SET public_name=EXCLUDED.public_name
    RETURNING id`,
    [fact.format, fact.signature, fact.publicName]
  )
  return row.id
}

async function registeredSnapshot(db, entryId) {
  const snapshot = { cards: [], sideboard: [] }
  const { rows } = await db.query(
    'SELECT zone,card_name,amount FROM tournament_entry_cards WHERE entry_id=$1 ORDER BY zone,position',
    [entryId]
  )
  for (const card of rows) snapshot[card.zone]?.push({ cardName: card.card_name, amount: card.amount })
  return snapshot
}

export async function recordTournamentDeck(db, entryId) {
  const {
    rows: [entry],
  } = await db.query(
    `
    SELECT t.format,r.list_signature,r.archetype,r.archetype_inferred,r.metadata->'colors' AS colors
    FROM tournament_entries e JOIN tournaments t ON t.id=e.tournament_id
    LEFT JOIN deck_revisions r ON (r.account_id,r.deck_id,r.revision)=(e.owner_id,e.deck_id,e.deck_revision)
    WHERE e.id=$1 FOR UPDATE OF e`,
    [entryId]
  )
  if (!entry) return
  const snapshot = await registeredSnapshot(db, entryId)
  const matches = snapshot.cards.length && deckListSignature(snapshot) === entry.list_signature
  const fact = resolveHistoricalDeck({
    format: entry.format,
    snapshot,
    registeredArchetypes: matches && !entry.archetype_inferred ? [entry.archetype] : [],
    declaredColors: matches ? entry.colors : null,
  })
  const composition = await storeComposition(db, fact)
  await db.query(
    `UPDATE tournament_entries SET opening_composition_id=$2,opening_archetype=$3,
    opening_identity_resolved=true, opening_colors=$4 WHERE id=$1`,
    [entryId, composition, fact.archetype, fact.colors]
  )
}

function consensusColors(rows) {
  const candidates = rows.map((row) => normalizedDeckColors(row.colors)).filter(Boolean)
  return candidates.every((colors) => colors.join('') === candidates[0].join('')) ? candidates[0] : null
}

export async function recordOpeningGameDeck(db, gameId, seat) {
  const {
    rows: [opening],
  } = await db.query(
    `
    SELECT p.deck_snapshot AS snapshot,p.archetype AS archived_label,m.table_id,COALESCE(m.format,m.engine_format) AS format
    FROM game_players p JOIN games g ON g.id=p.game_id JOIN matches m ON m.id=g.match_id
    WHERE p.game_id=$1 AND p.engine_key=$2 AND g.game_number=1
      AND (NOT p.opening_identity_resolved OR p.opening_composition_id IS NULL OR (NOT p.opening_snapshot_used AND p.deck_snapshot IS NOT NULL))
    FOR UPDATE OF p`,
    [gameId, seat]
  )
  if (!opening) return
  const snapshot = opening.snapshot
  const signature = snapshot?.cards?.length ? deckListSignature(snapshot) : null
  // A recovered physical table can carry the original seat registration. Restrict
  // every candidate to this table lineage and seat, never search the global library.
  const { rows: registrations } = await db.query(
    `
    WITH tables AS (SELECT $1::uuid AS table_id UNION SELECT b.table_id
      FROM tournament_pairing_tables a JOIN tournament_pairing_tables b USING(pairing_id) WHERE a.table_id=$1)
    SELECT d.list_signature,d.archetype_confirmed, d.archetype AS registered, r.archetype AS revision_archetype,
      r.archetype_inferred,r.metadata->'colors' AS colors
    FROM tables JOIN match_deck_registrations d USING(table_id)
    LEFT JOIN deck_revisions r ON (r.account_id,r.deck_id,r.list_version,r.list_signature)=
      (d.account_id,d.deck_id,d.list_version,d.list_signature)
    WHERE d.engine_key=$2 AND ($3::text IS NULL OR d.list_signature=$3)`,
    [opening.table_id, seat, signature]
  )
  const signatures = new Set(registrations.map((r) => r.list_signature))
  const reg = signatures.size === 1 ? registrations : []
  // The legacy archive label alone has no provenance. Recover it only when
  // exact, owner-scoped revisions agree. A deck id alone never selects its head.
  let library = []
  const libraryId = isId(snapshot?.libraryDeckId) ? snapshot.libraryDeckId : null
  const revision =
    libraryId && Number.isSafeInteger(snapshot?.revision) && snapshot.revision > 0 ? snapshot.revision : null
  if (!registrations.length && signature && (opening.archived_label || revision)) {
    const { rows } = await db.query(
      `
      SELECT r.archetype,r.metadata->'colors' AS colors
      FROM deck_revisions r JOIN decks d ON (r.account_id,r.deck_id)=(d.account_id,d.id)
      WHERE r.list_signature=$1 AND NOT r.archetype_inferred AND r.format IN ($2,'Constructed - '||$2)
        AND ($3::text IS NULL OR r.deck_id=$3) AND ($5::int IS NULL OR r.revision=$5)
        AND ((d.library='personal' AND EXISTS (SELECT 1 FROM accounts a WHERE a.id=r.account_id AND a.username_key=$4))
          OR EXISTS (SELECT 1 FROM agent_grants a WHERE a.account_id=r.account_id AND a.engine_key=$4
            AND (d.library='agent' OR (d.library='private' AND d.owner_player_id=a.player_id))))`,
      [signature, statisticsFormat(opening.format), libraryId, seat, revision]
    )
    if (revision || rows.every((r) => r.archetype === opening.archived_label)) library = rows
  }
  // A registration's label is frozen. Later revisions of the same list may
  // have different labels, and must not replace the submitted one.
  const confirmed = reg.filter((r) => r.archetype_confirmed === true)
  const legacyConfirmed =
    reg.length &&
    reg.every(
      (r) => r.archetype_confirmed === null && r.archetype_inferred === false && r.registered === r.revision_archetype
    )
  const labels = (confirmed.length ? confirmed : legacyConfirmed ? reg : []).map((r) => r.registered)
  const fact = resolveHistoricalDeck({
    format: opening.format,
    snapshot,
    registeredArchetypes: [...labels, ...library.map((r) => r.archetype)],
    registeredSignature: reg[0]?.list_signature,
    openingArchetypes: [snapshot?.archetype],
    declaredColors: consensusColors(reg.length ? reg : library),
  })
  const composition = await storeComposition(db, fact)
  await db.query(
    `UPDATE game_players SET opening_composition_id=$3,opening_archetype=$4,opening_identity_resolved=true,
    opening_colors=$5,opening_snapshot_used=$6 WHERE game_id=$1 AND engine_key=$2`,
    [gameId, seat, composition, fact.archetype, fact.colors, Boolean(signature)]
  )
}

export async function backfillOpeningDeckBatch(pool, limit = 16) {
  return transaction(pool, async (db) => {
    const { rows: entries } = await db.query(
      `SELECT id FROM tournament_entries WHERE NOT opening_identity_resolved
      ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit]
    )
    for (const entry of entries) await recordTournamentDeck(db, entry.id)
    const { rows: seats } = await db.query(
      `SELECT p.game_id,p.engine_key FROM game_players p JOIN games g ON p.game_id=g.id
      WHERE g.game_number=1 AND NOT p.opening_identity_resolved ORDER BY p.game_id,p.engine_key
      LIMIT $1 FOR UPDATE OF p SKIP LOCKED`,
      [limit]
    )
    for (const seat of seats) await recordOpeningGameDeck(db, seat.game_id, seat.engine_key)
    return entries.length + seats.length
  })
}

// Revisit only unknown palettes of already materialized starting lists. Keyset
// pagination also advances over snapshots the installed catalog cannot prove.
export async function backfillMissingDeckColors(pool, { lookup, limit = 16, stopped = () => false } = {}) {
  let changed = 0
  let cursor = ['', '00000000-0000-0000-0000-000000000000', '']
  while (!stopped()) {
    const { rows } = await pool.query(
      `SELECT candidates.*,c.list_signature FROM (
      SELECT 'entry' AS kind,id,'' AS seat,opening_composition_id AS composition FROM tournament_entries
      WHERE opening_identity_resolved AND opening_colors IS NULL
      UNION ALL
      SELECT 'game',p.game_id,p.engine_key,p.opening_composition_id FROM game_players p
      JOIN games g ON g.id=p.game_id WHERE g.game_number=1 AND p.opening_identity_resolved
        AND p.opening_colors IS NULL AND p.deck_snapshot IS NOT NULL
    ) candidates JOIN public_deck_compositions c ON c.id=composition
    WHERE (kind,candidates.id,seat)>($1,$2::uuid,$3) ORDER BY kind,candidates.id,seat LIMIT $4`,
      [...cursor, limit]
    )
    for (const row of rows) {
      const snapshot =
        row.kind === 'entry'
          ? await registeredSnapshot(pool, row.id)
          : (
              await pool.query('SELECT deck_snapshot FROM game_players WHERE game_id=$1 AND engine_key=$2', [
                row.id,
                row.seat,
              ])
            ).rows[0]?.deck_snapshot
      if (deckListSignature(snapshot) !== row.list_signature) continue
      const colors = mainColors(snapshot.cards, lookup)
      if (colors === null) continue
      // A simultaneous re-registration or newly supplied palette wins.
      const receipt =
        row.kind === 'entry'
          ? await pool.query(
              'UPDATE tournament_entries SET opening_colors=$3 WHERE id=$1 AND opening_composition_id=$2 AND opening_colors IS NULL',
              [row.id, row.composition, colors]
            )
          : await pool.query(
              'UPDATE game_players SET opening_colors=$3 WHERE game_id=$1 AND opening_composition_id=$2 AND opening_colors IS NULL AND engine_key=$4',
              [row.id, row.composition, colors, row.seat]
            )
      changed += receipt.rowCount
    }
    if (rows.length < limit) break
    const last = rows.at(-1)
    cursor = [last.kind, last.id, last.seat]
  }
  return changed
}

// The migration only runs while unresolved opening rows remain. Writes from
// regular ingestion and enrollment materialize their own facts transactionally.
export function startOpeningDeckBackfill(pool) {
  let closed = false,
    active,
    timer
  async function run() {
    try {
      while (!closed && (await backfillOpeningDeckBatch(pool))) await new Promise((resolve) => setImmediate(resolve))
      await backfillMissingDeckColors(pool, { stopped: () => closed })
    } catch {
      if (!closed) {
        console.warn('opening_deck_backfill_retry')
        timer = setTimeout(() => {
          active = run()
        }, 60_000)
        timer.unref()
      }
    }
  }
  active = run()
  return async () => {
    closed = true
    clearTimeout(timer)
    await active
  }
}
