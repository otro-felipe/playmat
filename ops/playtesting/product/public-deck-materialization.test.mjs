import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { migrateDeckLists, refineMigratedDeckLists } from './deck-list-migration.mjs'
import { deckListSignature } from './deck-performance-identity.mjs'
import {
  backfillOpeningDeckBatch,
  recordTournamentDeck,
  recordOpeningGameDeck,
} from './public-deck-materialization.mjs'

const url = process.env.PLAYMAT_TEST_DATABASE_URL
test(
  'opening registrations and competition snapshots survive library edits and repeated backfills',
  { skip: !url },
  async (t) => {
    const schema = 'test_deck_identity_' + randomUUID().replaceAll('-', '')
    const base = new Pool({ connectionString: url })
    await base.query('CREATE SCHEMA ' + schema)
    const db = new Pool({ connectionString: url, options: '-c search_path=' + schema })
    t.after(async () => {
      await db.end()
      await base.query('DROP SCHEMA ' + schema + ' CASCADE')
      await base.end()
    })
    for (const file of [
      'schema',
      'oauth-schema',
      'player-identities',
      'review-schema',
      'tournament-access',
      'tournaments',
      'performance-schema',
      'public-deck-identity',
    ])
      await db.query(await readFile(new URL(file + '.sql', import.meta.url), 'utf8'))
    await migrateDeckLists(db)
    await refineMigratedDeckLists(db)
    const [owner, tour, entry, table, match, g1, g2] = Array.from({ length: 7 }, () => randomUUID())
    const deck = { cards: [{ cardName: 'Unknown Fixture', amount: 60 }], sideboard: [] },
      sig = deckListSignature(deck)
    await db.query(
      "INSERT INTO accounts(id,username,username_key,password_hash) VALUES($1,'Owner','owner','synthetic')",
      [owner]
    )
    await db.query("INSERT INTO decks(account_id,id,head) VALUES($1,'fixture',2)", [owner])
    for (const [version, label] of [
      [1, 'Boros Aggro'],
      [2, 'Izzet Prowess'],
    ])
      await db.query(
        `INSERT INTO deck_revisions(account_id,deck_id,revision,name,format,archetype,list_version,list_signature,metadata)
      VALUES($1,'fixture',$2,'private name','Pioneer',$3,$2,$4,$5)`,
        [
          owner,
          version,
          label,
          version === 1 ? sig : 'another',
          JSON.stringify({ colors: { white: true, blue: false, black: false, red: true, green: false } }),
        ]
      )
    await db.query(
      `INSERT INTO tournaments(id,name,format,organizer_id,template,cut,capacity,swiss_best_of,playoff_best_of,max_agents_per_owner,coaching,break_minutes,created_at)
    VALUES($1,'Fixture','Pioneer',$2,'casual','none',8,3,5,8,false,5,0)`,
      [tour, owner]
    )
    await db.query(
      `INSERT INTO tournament_entries(id,tournament_id,owner_id,name,owner_name,engine_name,deck_id,deck_revision,deck_name)
    VALUES($1,$2,$3,'Owner','Owner','owner','fixture',1,'private name')`,
      [entry, tour, owner]
    )
    await db.query(
      "INSERT INTO tournament_entry_cards(entry_id,zone,position,card_name,amount) VALUES($1,'cards',1,'Unknown Fixture',60)",
      [entry]
    )
    await db.query("INSERT INTO matches(id,table_id,format,started_at,status) VALUES($1,$2,'Pioneer',0,'completed')", [
      match,
      table,
    ])
    await db.query(
      "INSERT INTO games(id,match_id,game_number,started_at,status,archive_state) VALUES($1,$3,1,0,'completed','ready'),($2,$3,2,0,'completed','ready')",
      [g1, g2, match]
    )
    await db.query(
      "INSERT INTO game_players(game_id,engine_key,engine_name,human) VALUES($1,'owner','Owner',true),($1,'anonymous','Anonymous',true),($2,'owner','Owner',true)",
      [g1, g2]
    )
    await db.query(
      "INSERT INTO match_deck_registrations VALUES($1,'owner',$2,'fixture',1,$3,'Boros Aggro','private name')",
      [table, owner, sig]
    )
    assert.ok(await backfillOpeningDeckBatch(db))
    assert.equal(await backfillOpeningDeckBatch(db), 0)
    const entryFact = () =>
      db
        .query('SELECT opening_composition_id id,opening_archetype label FROM tournament_entries WHERE id=$1', [entry])
        .then((x) => x.rows[0])
    const fact = await entryFact()
    assert.ok(fact.id)
    assert.equal(fact.label, 'Boros Aggro')
    const gameFact = (game, seat) =>
      db
        .query(
          'SELECT opening_composition_id id,opening_archetype label FROM game_players WHERE game_id=$1 AND engine_key=$2',
          [game, seat]
        )
        .then((x) => x.rows[0])
    assert.deepEqual(await gameFact(g1, 'owner'), fact)
    assert.deepEqual(await gameFact(g2, 'owner'), { id: null, label: null })
    assert.deepEqual(
      (
        await db.query(
          'SELECT e.opening_colors AS colors,c.public_name FROM tournament_entries e JOIN public_deck_compositions c ON c.id=e.opening_composition_id'
        )
      ).rows,
      [{ colors: ['W', 'R'], public_name: null }]
    )
    await db.query(
      "UPDATE game_players SET deck_snapshot=$2,archetype='Izzet Prowess' WHERE game_id=$1 AND engine_key='anonymous'",
      [g1, JSON.stringify({ ...deck, name: 'Secret Izzet Prowess' })]
    )
    await recordOpeningGameDeck(db, g1, 'anonymous')
    assert.deepEqual(await gameFact(g1, 'anonymous'), { id: fact.id, label: null })
    // Old archives can contain inferred labels, and a later library revision
    // can share the same list. Neither alone establishes the original metadata.
    await db.query('DELETE FROM match_deck_registrations WHERE table_id=$1', [table])
    const historical = async (snapshot, label) => {
      await db.query(
        "UPDATE game_players SET deck_snapshot=$2,archetype=$3,opening_identity_resolved=false WHERE game_id=$1 AND engine_key='owner'",
        [g1, JSON.stringify(snapshot), label]
      )
      await recordOpeningGameDeck(db, g1, 'owner')
      return (await gameFact(g1, 'owner')).label
    }
    assert.equal(await historical({ ...deck, libraryDeckId: 'fixture' }, null), null)
    assert.equal(await historical({ ...deck, libraryDeckId: 'fixture' }, 'Izzet Prowess'), null)
    assert.equal(await historical(deck, 'Boros Aggro'), 'Boros Aggro')
    assert.equal(await historical({ ...deck, libraryDeckId: 'fixture', revision: 1 }, null), 'Boros Aggro')
    await db.query('UPDATE deck_revisions SET archetype_inferred=true WHERE account_id=$1 AND revision=1', [owner])
    assert.equal(await historical({ ...deck, libraryDeckId: 'fixture', revision: 1 }, 'Boros Aggro'), null)
    await db.query('DELETE FROM deck_revisions WHERE account_id=$1 AND revision=1', [owner])
    assert.deepEqual(await entryFact(), fact)
    await db.query(
      "INSERT INTO tournament_entry_cards(entry_id,zone,position,card_name,amount) VALUES($1,'sideboard',1,'Unknown fixture',2)",
      [entry]
    )
    await recordTournamentDeck(db, entry)
    assert.notEqual((await entryFact()).id, fact.id)
    assert.equal((await entryFact()).label, null)
    const { backfillMissingDeckColors } = await import('./public-deck-materialization.mjs')
    const before = await entryFact()
    const lookup = (name) => (name === 'unknown fixture' ? 17 : null)
    await db.query("UPDATE tournament_entries SET opening_archetype='fixture frozen',opening_colors=NULL WHERE id=$1", [
      entry,
    ])
    await db.query('UPDATE game_players SET opening_colors=NULL WHERE game_id=$1', [g1])
    const count = await backfillMissingDeckColors(db, { lookup, limit: 1 })
    assert.ok(count >= 2)
    const {
      rows: [repaired],
    } = await db.query(
      'SELECT opening_composition_id,opening_archetype,opening_colors FROM tournament_entries WHERE id=$1',
      [entry]
    )
    assert.deepEqual(repaired, {
      opening_composition_id: before.id,
      opening_archetype: 'fixture frozen',
      opening_colors: ['W', 'G'],
    })
    await db.query("UPDATE game_players SET opening_colors=ARRAY['U'] WHERE game_id=$1", [g1])
    assert.equal(await backfillMissingDeckColors(db, { lookup, limit: 1 }), 0)
    assert.deepEqual(
      (await db.query("SELECT opening_colors FROM game_players WHERE game_id=$1 AND engine_key='owner'", [g1])).rows[0]
        .opening_colors,
      ['U']
    )
  }
)
