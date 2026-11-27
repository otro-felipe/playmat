import { storeTournamentScore } from './tournament-table-bridge.mjs'
import { canonicalAccountScope } from './players.mjs'
import { seatArchetype } from './archived-archetypes.mjs'
import { exclusionView } from './match-statistics.mjs'
import { createPerformance, historyFormatFilter } from './performance.mjs'
import { evidenceLoader } from './performance-evidence.mjs'
import { createHash } from 'node:crypto'
import { readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { createReadStream } from 'node:fs'
import { buffer as collectBytes } from 'node:stream/consumers'
import { constants, createGunzip, gunzip, gzip } from 'node:zlib'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { strToU8, zipSync } from 'fflate'
import { isUuid, normalize, normalizeFormat, ProductError, transaction } from './decks.mjs'
import { registerSelectedDeck } from './match-deck-registration.mjs'
import { viewerNames } from './identity.mjs'
import { evaluationPositions, scoreEvaluation } from './evaluation.mjs'
import { deleteExpiredReplayObjects, pruneMatchHistory } from './history-retention.mjs'

const unzip = promisify(gunzip)
const compress = promisify(gzip)
const compressedLimit = 24 * 1024 * 1024
const decompressedLimit = 96 * 1024 * 1024
const exportLimit = 32 * 1024 * 1024
const digest = body => createHash('sha256').update(body).digest('hex')
const maxEntries = 10
const standardLogTypes = new Set(['GAME', 'STATUS'])

function engineFormat(value) {
  return typeof value === 'string' && value.trim().length <= 120 && !/\p{Cc}/u.test(value)
    ? value.trim() || null : null
}

export function s3Store({ bucket, endpoint, region, forcePathStyle = false }) {
  if (!bucket || !region) throw new Error('Replay archive bucket and region are required')
  const s3 = new S3Client({ region, endpoint, forcePathStyle })
  return {
    async put(key, bytes, sha256, size = bytes.length) {
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: bytes, ContentType: 'application/x-ndjson',
          ContentEncoding: 'gzip', ContentLength: size,
          ...(!Buffer.isBuffer(bytes) && { ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64') }),
          Metadata: { sha256 }, IfNoneMatch: '*',
        }), { abortSignal: AbortSignal.timeout(size > compressedLimit ? 300_000 : 20_000) })
      } catch (error) {
        if (error.$metadata?.httpStatusCode !== 412) throw error
      }
    },
    async get(key) {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(20_000) })
      if (!result.Body || !(result.ContentLength <= compressedLimit)) {
        result.Body?.destroy()
        throw new ProductError(503, 'Replay object is unavailable for bulk reading')
      }
      return Buffer.from(await result.Body.transformToByteArray())
    },
    async open(key) {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(300_000) })
      if (!result.Body) throw new ProductError(503, 'Replay object is unavailable')
      return result.Body
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(5000) })
    },
  }
}

function fromLocal(store) {
  return store instanceof Map ? {
    put: async (key, body) => store.set(key, Buffer.isBuffer(body) ? body : await collectBytes(body)),
    get: async key => store.get(key), delete: async key => store.delete(key),
  } : store
}

function replayMetadata(raw, gameId) {
  if (raw.gameId !== gameId || !Array.isArray(raw.players) || raw.players.length < 1 || !Number.isSafeInteger(raw.startedAt)) {
    throw new Error('Invalid replay metadata')
  }
  return {
    gameId, matchId: isUuid(raw.matchId) ? raw.matchId : isUuid(raw.tableId) ? raw.tableId : gameId,
    tableId: isUuid(raw.tableId) ? raw.tableId : gameId, tableName: raw.tableName ?? '',
    format: normalizeFormat(raw.deckType), engineFormat: engineFormat(raw.deckType),
    reviewVersion: raw.reviewVersion === 2 ? 2 : null, reviewIncomplete: raw.reviewIncomplete === true, winsNeeded: raw.winsNeeded ?? null,
    gameNumber: Number.isSafeInteger(raw.gameNumber) ? raw.gameNumber : 1,
    startedAt: raw.startedAt, endedAt: raw.endedAt || null,
    result: raw.result ?? null, winner: raw.winner ?? null, startPlayer: raw.startPlayer ?? null,
    turns: raw.turns ?? null, events: raw.events ?? 0, truncated: Boolean(raw.truncated),
    players: raw.players.filter(p => typeof p.name === 'string').map(p => ({
      name: p.name, playerId: isUuid(p.playerId) ? p.playerId : null,
      human: p.human === true, deck: p.deck ?? null, mulligans: p.mulligans ?? null,
    })),
  }
}

function deckSignature(deck) {
  if (!deck) return null
  const entries = new Map()
  for (const zone of ['cards', 'sideboard']) {
    for (const card of deck[zone] ?? []) {
      const key = JSON.stringify([zone, card.cardName ?? card.name ?? card, card.setCode ?? card.set ?? null, card.cardNumber ?? card.number ?? null])
      entries.set(key, (entries.get(key) ?? 0) + (card.amount ?? card.quantity ?? 1))
    }
  }
  return digest(JSON.stringify([...entries].sort(([left], [right]) => left.localeCompare(right))))
}

async function recordMetadata(pool, info, status, recovering, recordOpeningGameDeck) {
  const interrupted = recovering || status === 'interrupted' || status === 'abandoned'
  return transaction(pool, async db => {
    // Lock an existing match before checking the tombstone, so maintenance cannot
    // remove the row between deciding to archive it and recording game metadata.
    await db.query('SELECT 1 FROM matches WHERE id=$1 FOR UPDATE', [info.matchId])
    if (await wasPurged(db, info.matchId)) return false
    await db.query(
      `INSERT INTO matches(id,table_id,name,format,wins_needed,started_at,status,engine_format) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(id) DO UPDATE SET started_at=LEAST(matches.started_at,EXCLUDED.started_at),
         status=CASE WHEN matches.status='active' THEN EXCLUDED.status ELSE matches.status END,
         engine_format=COALESCE(matches.engine_format,EXCLUDED.engine_format)`,
      [info.matchId, info.tableId, info.tableName, info.format, info.winsNeeded, info.startedAt,
        interrupted ? 'interrupted' : 'active', info.engineFormat],
    )
    await db.query(
      `INSERT INTO games(id,match_id,game_number,started_at,ended_at,result,winner,start_player,turns,events,status,archive_state,truncated,review_version,review_incomplete)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT(id) DO UPDATE SET ended_at=EXCLUDED.ended_at,result=EXCLUDED.result,winner=EXCLUDED.winner,
         start_player=EXCLUDED.start_player,turns=EXCLUDED.turns,events=EXCLUDED.events,
         status=EXCLUDED.status,truncated=EXCLUDED.truncated,review_version=COALESCE(games.review_version,EXCLUDED.review_version),
         review_incomplete=games.review_incomplete OR EXCLUDED.review_incomplete
       WHERE games.status IN ('active','interrupted') OR EXCLUDED.status='completed'`,
      [info.gameId, info.matchId, info.gameNumber, info.startedAt, info.endedAt, info.result, info.winner, info.startPlayer,
        info.turns, info.events, status, status === 'interrupted' || status === 'abandoned' || info.truncated ? 'partial' : 'pending',
        info.truncated, info.reviewVersion, info.reviewIncomplete],
    )
    const { rows: runtimes } = await db.query(`
      SELECT lower(e.engine_name) AS seat,e.provider,e.model,e.reasoning_effort
      FROM tournament_pairing_tables physical JOIN tournament_pairings pair ON pair.id=physical.pairing_id
      JOIN tournament_entries e ON e.id IN (pair.entry_a,pair.entry_b) WHERE physical.table_id=$1
      UNION ALL SELECT creator_key,creator_provider,creator_model,creator_effort FROM invitations WHERE table_id=$1
      UNION ALL SELECT invitee_key,guest_provider,guest_model,guest_effort FROM invitations WHERE table_id=$1`, [info.tableId])
    for (const player of info.players) {
      const seat = normalize(player.name)
      if (info.gameNumber === 1 && player.human) await registerSelectedDeck(db, info.tableId, seat, player.deck)
      const label = await seatArchetype(db, info.tableId, seat, info.format ?? info.engineFormat, player.deck, info.matchId)
      const { provider, model, reasoning_effort } = runtimes.find(runtime => runtime.seat === seat) ?? {}
      await db.query(
        `INSERT INTO game_players(game_id,engine_key,engine_name,human,deck_snapshot,mulligans,deck_signature,player_id,model,reasoning_effort,archetype,provider)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(game_id,engine_key)
         DO UPDATE SET mulligans=COALESCE(EXCLUDED.mulligans,game_players.mulligans),
                       deck_snapshot=COALESCE(game_players.deck_snapshot,EXCLUDED.deck_snapshot),
                       deck_signature=COALESCE(game_players.deck_signature,EXCLUDED.deck_signature),
                       player_id=COALESCE(game_players.player_id,EXCLUDED.player_id),
                       provider=COALESCE(game_players.provider,EXCLUDED.provider),
                       model=COALESCE(game_players.model,EXCLUDED.model),
                       archetype=COALESCE(game_players.archetype,EXCLUDED.archetype),
                       reasoning_effort=COALESCE(game_players.reasoning_effort,EXCLUDED.reasoning_effort)`,
        [info.gameId, seat, player.name, player.human, player.deck, player.mulligans, deckSignature(player.deck),
          player.playerId, model, reasoning_effort, label, provider],
      )
      if (info.gameNumber === 1) await recordOpeningGameDeck?.(db, info.gameId, seat)
      // A recovered spool may archive game two before the opening registration.
      if (info.gameNumber === 1 && label) await db.query(`UPDATE game_players p SET archetype=$3
        FROM games g WHERE g.id=p.game_id AND g.match_id=$1 AND g.game_number>1
        AND p.engine_key=$2 AND p.archetype IS DISTINCT FROM $3`, [info.matchId, seat, label])
    }
    return true
  })
}

async function wasPurged(db, matchId) {
  const { rowCount } = await db.query('SELECT 1 FROM purged_match_history WHERE match_id=$1', [matchId])
  return rowCount > 0
}

export function projectReplayEvent(event, viewer) {
  if (event.log && standardLogTypes.has(event.log.messageType)) return { t: event.t, log: pick(event.log, [
    'color', 'message', 'messageType', 'soundToPlay', 'time', 'turnInfo', 'username',
  ]) }
  if (event.kind === 'rollback' && Number.isInteger(event.turn)) return { t: event.t, kind: 'rollback', turn: event.turn }
  if (!event.view || typeof event.view !== 'object') return null
  const view = pick(event.view, [
    'activePlayerId', 'activePlayerName', 'attackOption', 'bufferTime', 'combat', 'companion', 'events',
    'exilePresentation', 'exiles', 'gameCycle', 'phase', 'priorityPlayerName', 'priorityTime', 'rangeOfInfluence',
    'revealed', 'rollbackTurnsAllowed', 'stack', 'step', 'turn',
  ])
  view.players = (event.view.players ?? []).map(player => pick(player, [
    'attachments', 'battlefield', 'commandList', 'counters', 'designationNames', 'exile', 'graveyard',
    'handCount', 'hasLeft', 'hasPriority', 'initiative', 'isActive', 'isHuman', 'libraryCount', 'life',
    'manaPool', 'monarch', 'name', 'playerId', 'topCard', 'wins', 'winsNeeded',
  ]))
  const entry = Object.entries(event.hands ?? {}).find(([name]) => normalize(name) === viewer)
  return entry ? { t: event.t, view, myHand: entry[1] } : { t: event.t, view }
}

function pick(fields, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(fields, key)).map(key => [key, fields[key]]))
}

async function rawEvents(store, game) {
  if (!game.object_key) throw new ProductError(409, 'Replay is still being archived')
  const body = await store.get(game.object_key)
  if (!body || body.length > compressedLimit || digest(body) !== game.checksum) throw new ProductError(503, 'Replay cannot be verified')
  const plain = await unzip(body, { maxOutputLength: decompressedLimit })
  return plain.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function openReplay(store, key) {
  if (store.open) return store.open(key)
  const bytes = await store.get(key)
  if (!bytes) throw new ProductError(503, 'Replay object is unavailable')
  return Readable.from([bytes])
}

async function sha256Stream(stream) {
  const hash = createHash('sha256')
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

// Keep the per-record guard while allowing any number of recorded turns in an archive.
// Verify the compressed checksum before returning any page or publishing an index.
async function* streamReplayRecords(store, game) {
  if (!game.object_key) throw new ProductError(409, 'Replay is still being archived')
  const input = await openReplay(store, game.object_key)
  const hash = createHash('sha256')
  async function* verifiedChunks() {
    for await (const chunk of input) {
      hash.update(chunk)
      yield chunk
    }
    if (hash.digest('hex') !== game.checksum) throw new ProductError(503, 'Replay cannot be verified')
  }
  const inflated = Readable.from(verifiedChunks()).compose(createGunzip({ chunkSize: 128 * 1024 }))
  let parts = [], size = 0
  try {
    for await (const chunk of inflated) {
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start)
        const end = newline < 0 ? chunk.length : newline
        const piece = chunk.subarray(start, end)
        size += piece.length
        if (size > decompressedLimit) throw new ProductError(503, 'Replay record is too large')
        if (piece.length) parts.push(piece)
        if (newline < 0) break
        if (size) yield JSON.parse(Buffer.concat(parts, size).toString('utf8'))
        parts = []
        size = 0
        start = newline + 1
      }
    }
    if (size) yield JSON.parse(Buffer.concat(parts, size).toString('utf8'))
  } finally {
    inflated.destroy()
    input.destroy()
  }
}

async function projectedEvents(store, game, viewer) {
  return (await rawEvents(store, game)).map(event => projectReplayEvent(event, viewer)).filter(Boolean)
}

function gameView(row) {
  return {
    gameId: row.id, matchId: row.match_id, tableId: row.table_id, tableName: row.name,
    deckType: row.engine_format ?? (row.format ? 'Constructed - ' + row.format : undefined), gameNumber: row.game_number,
    startedAt: Number(row.started_at), endedAt: row.ended_at === null ? 0 : Number(row.ended_at),
    result: row.result, winner: row.winner, startPlayer: row.start_player, turns: row.turns,
    events: row.events, archiveState: row.archive_state, status: row.status,
    truncated: row.truncated, players: row.players, replayAvailable: Boolean(row.object_key && row.viewer),
    ownMulligans: row.own_mulligans, viewerName: row.viewer, endCause: row.end_cause ?? null,
    goodQuality: row.good_quality,
  }
}

// XMage ends the whole match when a seat times out (inactivity or player clock) or leaves, not only the game.
export const matchEndingCauses = new Set(['inactivity', 'player_clock', 'round_clock', 'disconnect'])
export const replayEndCauses = new Set([...matchEndingCauses, 'concession'])

// The last game's non-played ending explains a completed match that stopped early.
function matchEndCause(match, games) {
  if (match.status !== 'completed') return null
  const last = games.filter(game => game.status === 'completed').at(-1)
  return matchEndingCauses.has(last?.endCause) ? last.endCause : null
}

// Viewer seats are $1. Owned profile seats ($N) view only completed matches: an account
// connection never reads a live hand of its own players while another pilot is still playing.
const viewerSeat = profiles => `(p.engine_key=ANY($1::text[]) OR (m.status='completed' AND p.engine_key=ANY($${profiles}::text[])))`
const viewerOrder = profiles => `array_position($1::text[] || $${profiles}::text[],p.engine_key)`
const selectGame = profiles => `
  SELECT g.*, m.table_id, m.name, m.format, m.engine_format, m.status AS match_status,
    (SELECT json_agg(jsonb_build_object('name',p.engine_name,'human',p.human,'displayName',COALESCE(profile.display_name,a.username,p.engine_name),
        'isMcp',a.id IS NOT NULL,'model',p.model,'reasoningEffort',p.reasoning_effort)
        || CASE WHEN p.provider IS NOT NULL THEN jsonb_build_object('provider',p.provider) ELSE '{}'::jsonb END
        || CASE WHEN profile.id IS NOT NULL THEN jsonb_build_object('profileId',profile.id,'flag',profile.flag) ELSE '{}'::jsonb END
        || CASE WHEN p.engine_key=delegated_owner.username_key THEN '{"humanMcpAllowed":true}'::jsonb ELSE '{}'::jsonb END
        || CASE WHEN m.status='completed' AND p.archetype IS NOT NULL
             AND (${viewerSeat(profiles)} OR match_deck_published(m.table_id,p.engine_key)) THEN jsonb_build_object('archetype',p.archetype)
                ELSE '{}'::jsonb END ORDER BY p.engine_name)
       FROM game_players p LEFT JOIN agent_grants seat ON p.human AND seat.engine_key=p.engine_key
       LEFT JOIN accounts a ON a.id=seat.account_id LEFT JOIN player_profiles profile ON profile.id=seat.player_id WHERE p.game_id=g.id) AS players,
    (SELECT p.engine_key FROM game_players p WHERE p.game_id=g.id AND ${viewerSeat(profiles)}
       ORDER BY ${viewerOrder(profiles)} LIMIT 1) AS viewer,
    (SELECT p.mulligans FROM game_players p WHERE p.game_id=g.id AND ${viewerSeat(profiles)}
       ORDER BY ${viewerOrder(profiles)} LIMIT 1) AS own_mulligans
  FROM games g JOIN matches m ON m.id=g.match_id
  LEFT JOIN human_match_seats hs ON hs.table_id=m.table_id AND hs.allowed
  LEFT JOIN accounts delegated_owner ON delegated_owner.id=hs.account_id`

function cursorFrom(row) {
  return Buffer.from(JSON.stringify([row.started_at, row.id])).toString('base64url')
}

function parseCursor(cursor) {
  if (cursor == null) return [null, null]
  try {
    if (cursor.length > 300) throw Error()
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (!/^\d{1,14}$/.test(at) || !isUuid(id)) throw Error()
    return [at, id]
  } catch {
    throw new ProductError(400, 'Invalid history cursor')
  }
}

export function createArchive(pool, stage, backend, { purgeExpiredHistory = false, recordOpeningGameDeck } = {}) {
  const store = fromLocal(backend)
  if (purgeExpiredHistory && typeof store?.delete !== 'function') throw Error('Match history purge requires a replay store with deletion support')
  let activeScan
  let nextHistoryMaintenance = 0
  let nextEvidenceBackfill = 0
  let nextEndCauseBackfill = 0
  // Public statistics read each seat's kept opening hand from its own replay evidence.
  // Record it when a game is archived, and retry missing evidence for eligible games.
  const loadEvidence = evidenceLoader(pool, game => rawEvents(store, game))
  async function recordEvidence(where, values) {
    try {
      const { rows } = await pool.query(`SELECT g.id,g.archive_state,g.object_key,g.checksum,p.engine_key,p.engine_name,p.player_id
        FROM games g JOIN game_players p ON p.game_id=g.id
        WHERE g.status='completed' AND g.archive_state='ready' AND g.checksum IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM game_performance_evidence e WHERE (e.game_id,e.engine_key)=(g.id,p.engine_key))
          AND ${where}`, values)
      if (rows.length) await loadEvidence(rows)
    } catch {
      console.warn('Playmat opening-hand evidence delayed')
    }
  }

  async function scan({ markInterrupted = false, maintainHistory = Date.now() >= nextHistoryMaintenance } = {}) {
    if (markInterrupted) {
      // The single application replica starts with ingress closed. Its previous engine process
      // cannot still be playing. Sideboarding may leave no active game file to recover.
      await transaction(pool, async db => {
        await db.query("UPDATE matches SET status='interrupted' WHERE status='active'")
        await db.query("UPDATE games SET status='interrupted', archive_state='partial' WHERE status='active'")
      })
    }
    let files
    try {
      files = await readdir(stage)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      files = []
    }
    const knownFiles = new Set(files)
    const pendingMatches = new Set()
    const archivedGames = []
    // Ingest the game records first so a match's final marker can finalize even a match that
    // never made it to PostgreSQL before process exit.
    files.sort((left, right) => Number(left.endsWith('.match.json')) - Number(right.endsWith('.match.json')))
    for (const file of files) {
      const match = /^([\da-f-]+)(\.active|\.interrupted|\.match)?\.json$/i.exec(file)
      if (!match || !isUuid(match[1])) continue
      const [, id, variant] = match
      let pendingMatchId = variant === '.match' ? id : null
      try {
        const raw = JSON.parse(await readFile(join(stage, file), 'utf8'))
        if (variant === '.match') {
          if (raw.matchId === id && Number.isSafeInteger(raw.endedAt)) {
            await storeTournamentScore(pool, raw)
            // Physical table history identifies tournament markers across restores, even without a native score.
            // Their reservations are released with the pairing result, under its lock.
            const saved = await pool.query(`WITH finished AS (UPDATE matches SET status='completed', ended_at=$2, winner=$3 WHERE id=$1 RETURNING table_id),
              released AS (DELETE FROM player_table_reservations r USING finished f
                WHERE f.table_id IN (r.table_id,r.original_table_id) AND tournament_pairing_for_table(f.table_id) IS NULL)
              SELECT table_id FROM finished`, [id, raw.endedAt, raw.winner ?? null])
            if (saved.rowCount || await wasPurged(pool, id)) await unlink(join(stage, file))
          }
          continue
        }
        if (raw.batchOwner) continue
        if (variant === '.active' && knownFiles.has(id + '.json')) {
          await unlink(join(stage, file))
          continue
        }
        const info = replayMetadata(raw, id)
        pendingMatchId = info.matchId
        if (variant === '.active') {
          if (markInterrupted) {
            await rename(join(stage, file), join(stage, id + '.interrupted.json'))
            await recordMetadata(pool, info, 'interrupted', false, recordOpeningGameDeck)
          } else {
            if (await recordMetadata(pool, info, 'active', false, recordOpeningGameDeck)) pendingMatches.add(info.matchId)
            else await removeStaging(join(stage, file), join(stage, id + '.ndjson.gz.part'))
          }
          continue
        }
        const interrupted = variant === '.interrupted'
        const status = interrupted ? 'interrupted' : (info.result || info.winner ? 'completed' : 'abandoned')
        const eventPath = join(stage, id + '.ndjson.gz' + (interrupted ? '.part' : ''))
        if (!await recordMetadata(pool, info, status, markInterrupted, recordOpeningGameDeck)) {
          await removeStaging(join(stage, file), eventPath)
          continue
        }
        if (markInterrupted) continue
        const previous = (await pool.query('SELECT checksum FROM games WHERE id=$1', [id])).rows[0]
        if (previous?.checksum) {
          await removeStaging(join(stage, file), eventPath)
          continue
        }
        const size = (await stat(eventPath)).size
        if (interrupted && size > compressedLimit) {
          await pool.query("UPDATE games SET archive_state='partial', truncated=TRUE WHERE id=$1", [id])
          continue
        }
        // Completed archives can be much larger than an interactive bulk download.
        // Hash, upload and verify large spools sequentially without loading them into memory.
        let bytes = size <= compressedLimit ? await readFile(eventPath) : null
        if (interrupted) {
          bytes = await recoverInterrupted(bytes)
          if (!bytes) {
            await removeStaging(join(stage, file), eventPath)
            continue
          }
        }
        const hash = bytes ? digest(bytes) : await sha256Stream(createReadStream(eventPath))
        const key = ['replays', 'v1', id, hash + '.ndjson.gz'].join('/')
        const upload = bytes ?? createReadStream(eventPath)
        try {
          await store.put(key, upload, hash, bytes?.length ?? size)
        } finally {
          if (!bytes) upload.destroy()
        }
        const uploadedHash = await sha256Stream(await openReplay(store, key))
        if (uploadedHash !== hash) throw new Error('Archive verification failed')
        await pool.query('UPDATE games SET archive_state=$2, checksum=$3, object_key=$4 WHERE id=$1 AND checksum IS NULL', [
          id, info.truncated || status !== 'completed' ? 'partial' : 'ready', hash, key,
        ])
        await removeStaging(join(stage, file), eventPath)
        await recordEvidence('g.id=$1', [id])
        archivedGames.push(id)
      } catch (error) {
        if (pendingMatchId) pendingMatches.add(pendingMatchId)
        if (error.code !== 'ENOENT') console.warn('Playmat replay archive retry scheduled', { gameId: id })
      }
    }
    if (!markInterrupted && Date.now() >= nextEvidenceBackfill) {
      nextEvidenceBackfill = Date.now() + 60_000
      await recordEvidence(`g.id IN (SELECT g2.id FROM games g2 JOIN statistically_eligible_matches m ON m.id=g2.match_id
        WHERE g2.status='completed' AND g2.archive_state='ready' AND g2.checksum IS NOT NULL
          AND (SELECT count(*) FROM game_performance_evidence e WHERE e.game_id=g2.id)
            < (SELECT count(*) FROM game_players p2 WHERE p2.game_id=g2.id)
        ORDER BY random() LIMIT 4)`, [])
    }
    if (archivedGames.length) await recordEndCauses(archivedGames.length, archivedGames)
    if (!markInterrupted && Date.now() >= nextEndCauseBackfill) {
      nextEndCauseBackfill = Date.now() + 60_000
      await recordEndCauses()
    }
    if (purgeExpiredHistory && !markInterrupted && maintainHistory) {
      nextHistoryMaintenance = Date.now() + 60_000
      await pruneMatchHistory(pool, pendingMatches)
      await deleteExpiredReplayObjects(pool, store)
    }
  }

  // Read the terminal marker of just archived games, then of older games newest first. A failed read stays unchecked.
  async function recordEndCauses(limit = 8, ids = null) {
    const { rows } = await pool.query(`SELECT id,object_key,checksum FROM games
      WHERE status='completed' AND checksum IS NOT NULL AND object_key IS NOT NULL AND NOT end_cause_checked
        AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[]))
      ORDER BY ended_at DESC NULLS LAST,id LIMIT $1`, [limit, ids])
    for (const game of rows) {
      try {
        let cause = null
        for await (const record of streamReplayRecords(store, game)) {
          if (record?.kind === 'spectatorEnd' && record.terminal === true) cause = replayEndCauses.has(record.cause) ? record.cause : null
        }
        await pool.query('UPDATE games SET end_cause=$2,end_cause_checked=TRUE WHERE id=$1', [game.id, cause])
      } catch {
        console.warn('Playmat replay end cause retry scheduled', { gameId: game.id })
      }
    }
    return rows.length
  }

  async function recoverInterrupted(bytes) {
    let recovered
    try {
      recovered = await unzip(bytes, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: decompressedLimit })
    } catch {
      return null
    }
    const lastNewline = recovered.lastIndexOf(10)
    return lastNewline > 0 ? compress(recovered.subarray(0, lastNewline + 1)) : null
  }

  async function removeStaging(metadata, events) {
    for (const file of [events, metadata]) {
      try {
        await unlink(file)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }

  function archiveGames(options) {
    if (!activeScan) activeScan = scan(options).finally(() => { activeScan = null })
    return activeScan
  }

  // The account connection also views its own players' completed games, as its browser session does.
  // A perspective chooses exactly one owned player's seat.
  async function historySeats(actor) {
    if (actor.perspectiveSeat) return { seats: [], profiles: [actor.perspectiveSeat] }
    const profiles = canonicalAccountScope(actor,'history')
      ? (await pool.query('SELECT engine_key FROM agent_grants WHERE account_id=$1 AND player_id IS NOT NULL ORDER BY created_at,engine_key',
        [actor.accountId])).rows.map(row => row.engine_key)
      : []
    return { seats: viewerNames(actor), profiles }
  }

  async function authorizedGame(actor, id) {
    if (!isUuid(id)) throw new ProductError(404, 'Replay not found')
    const { seats, profiles } = await historySeats(actor)
    const { rows: [game] } = await pool.query(
      `${selectGame(4)} JOIN retained_match_history h ON h.match_id=m.id AND h.account_id=$3
       WHERE g.id=$2 AND EXISTS(SELECT 1 FROM game_players p WHERE p.game_id=g.id AND ${viewerSeat(4)})`,
      [seats, id, actor.accountId, profiles],
    )
    if (!game) throw new ProductError(404, 'Replay not found')
    return game
  }

  const reviewMetadata = `
    SELECT g.id,g.match_id,g.game_number,g.status,g.archive_state,g.object_key,g.checksum,g.review_version,g.review_incomplete,g.truncated,g.good_quality,
      g.quality_reason,g.quality_anchor_kind,g.quality_anchor_cursor,g.quality_archive_revision,g.end_cause,
      m.status AS match_status,m.format,m.engine_format,
      (SELECT json_agg(json_build_object('name',p.engine_name,'seatId',p.engine_key,'playerId',p.player_id,'human',p.human)
                       ORDER BY p.engine_key)
       FROM game_players p WHERE p.game_id=g.id) AS players
    FROM games g JOIN matches m ON m.id=g.match_id`

  // Internal lookup only. The review service checks exact match ownership before reading the archive.
  async function reviewGame(id, db = pool) {
    if (!isUuid(id)) throw new ProductError(404, 'Replay not found')
    const { rows: [game] } = await db.query(reviewMetadata + ' WHERE g.id=$1', [id])
    if (!game) throw new ProductError(404, 'Replay not found')
    return game
  }

  async function reviewGames(matchId) {
    const { rows } = await pool.query(reviewMetadata + ' WHERE g.match_id=$1 ORDER BY g.game_number,g.id', [matchId])
    return rows
  }

  // The caller supplies the authenticated seat. No other seat's deck is loaded.
  async function reviewOwnDeckPair(gameId, seatId) {
    const { rows } = await pool.query(`
      SELECT earlier.game_number AS "fromGameNumber", current_game.game_number AS "toGameNumber",
        previous_seat.deck_snapshot AS "previousDeck", current_seat.deck_snapshot AS "currentDeck",
        earlier.status='completed' AND earlier.checksum IS NOT NULL AS "previousCompleted"
      FROM games current_game
      JOIN matches encounter ON encounter.id=current_game.match_id AND encounter.status='completed'
      JOIN games earlier ON earlier.match_id=current_game.match_id AND earlier.game_number=current_game.game_number-1
      LEFT JOIN game_players previous_seat ON previous_seat.game_id=earlier.id AND previous_seat.engine_key=$2
      JOIN game_players current_seat ON current_seat.game_id=current_game.id AND current_seat.engine_key=$2
      WHERE current_game.id=$1 AND current_game.status='completed' AND current_game.checksum IS NOT NULL
      LIMIT 2`, [gameId, seatId])
    return rows.length === 1 && rows[0].previousCompleted ? rows[0] : null
  }

  async function matchList(actor, opts = {}) {
    const [older, earlierMatch] = parseCursor(opts.cursor)
    const format = historyFormatFilter(opts.format)
    const limit = Math.max(1, Math.min(100, Number.parseInt(opts.limit ?? '25', 10) || 25))
    const matchId = opts.id ?? null
    if (matchId !== null && !isUuid(matchId)) throw new ProductError(404, 'Match not found')
    const { seats, profiles: profileSeats } = await historySeats(actor)
    // Profile ownership extends completed score lookup and the replay viewer seat.
    const resultSeat = viewerSeat(3)
    const { rows } = await pool.query(
      `SELECT m.*, x.reason, x.author, x.marked_at FROM matches m JOIN retained_match_history h ON h.match_id=m.id AND h.account_id=$2
       LEFT JOIN match_statistics_exclusions x ON x.match_id=m.id
       WHERE ($4::text IS NULL OR COALESCE(m.format,m.engine_format,'Unknown')=$4)
         AND ($5::bigint IS NULL OR (m.started_at,m.id)<($5,$6::uuid))
         AND ($8::uuid IS NULL OR m.id=$8)
         AND EXISTS(SELECT 1 FROM games g JOIN game_players p ON p.game_id=g.id WHERE g.match_id=m.id AND ${resultSeat})
       ORDER BY m.started_at DESC,m.id DESC LIMIT $7`,
      [seats, actor.accountId, profileSeats, format, older, earlierMatch, limit + 1, matchId],
    )
    const page = rows.slice(0, limit)
    const { rows: games } = await pool.query(
      `${selectGame(3)} WHERE g.match_id=ANY($2::uuid[]) AND EXISTS(SELECT 1 FROM game_players p WHERE p.game_id=g.id AND ${resultSeat})
       ORDER BY g.game_number,g.id`,
      [seats, page.map(m => m.id), profileSeats],
    )
    return {
      matches: page.map(m => ({
        id: m.id, tableId: m.table_id, name: m.name, format: m.format ?? m.engine_format ?? 'Unknown', status: m.status, winner: m.winner,
        startedAt: Number(m.started_at), endedAt: m.ended_at ? Number(m.ended_at) : null,
        statisticsExclusion: exclusionView(m), canExcludeFromStatistics: !actor.agent && m.status !== 'active' && !m.reason,
        ...(views => ({ endCause: matchEndCause(m, views), games: views }))(games.filter(g => g.match_id === m.id).map(gameView)),
      })),
      cursor: rows.length > limit ? cursorFrom(page.at(-1)) : null,
    }
  }

  async function replayPage(actor, id, start, count) {
    const game = await authorizedGame(actor, id)
    const from = Math.max(0, Number.parseInt(start ?? '0', 10) || 0)
    const take = Math.max(1, Math.min(200, Number.parseInt(count ?? '100', 10) || 100))
    const includeCursor = game.status === 'completed' && game.match_status === 'completed'
    const events = []
    let total = 0, cursor = 0
    // Page offsets count visible events. Review cursors refer to the original recording.
    for await (const record of streamReplayRecords(store, game)) {
      const projection = projectReplayEvent(record, game.viewer)
      if (projection) {
        if (total >= from && events.length < take) events.push(includeCursor ? { ...projection, cursor } : projection)
        total++
      }
      cursor++
    }
    return { info: gameView(game), total, start: Math.min(total, from), events }
  }

  async function evaluation(actor, id, options = {}) {
    const game = await authorizedGame(actor, id)
    if (game.status !== 'completed' || !game.object_key) {
      throw new ProductError(409, 'Wait for the completed game to be archived')
    }
    const events = await projectedEvents(store, game, game.viewer)
    const positions = evaluationPositions(events, game.viewer)
    const base = {
      gameId: game.id, matchId: game.match_id, format: game.format,
      perspective: game.players.find(player => normalize(player.name) === game.viewer)?.name,
      partialReplay: game.archive_state !== 'ready',
    }
    if (Object.hasOwn(options, 'reviews')) return { ...base, ...scoreEvaluation(positions, options.reviews) }
    const start = Math.min(positions.length, Math.max(0, Number.parseInt(options.start, 10) || 0))
    const count = Math.min(4, Math.max(1, Number.parseInt(options.count, 10) || 4))
    const end = start + count
    return { ...base, total: positions.length, next: end < positions.length ? end : null, positions: positions.slice(start, end) }
  }

  const { statistics, performance } = createPerformance(pool, game => rawEvents(store, game))

  async function authorizeExport(actor, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > maxEntries || ids.some(id => !isUuid(id))) {
      throw new ProductError(400, 'Select up to ' + maxEntries + ' valid replay game IDs')
    }
    return Promise.all([...new Set(ids)].map(id => authorizedGame(actor, id)))
  }

  async function exportReplays(actor, ids) {
    const games = await authorizeExport(actor, ids)
    const all = {}
    const manifest = { schemaVersion: 1, games: [] }
    let totalBytes = 0
    for (const game of games) {
      const events = await projectedEvents(store, game, game.viewer)
      const { rows: [own] } = await pool.query('SELECT deck_snapshot,mulligans FROM game_players WHERE game_id=$1 AND engine_key=$2', [game.id, game.viewer])
      const bytes = strToU8(events.map(event => JSON.stringify(event)).join('\n') + '\n')
      totalBytes += bytes.length
      if (totalBytes > exportLimit) throw new ProductError(413, 'Select fewer games for export')
      all[game.id + '.jsonl'] = bytes
      manifest.games.push({ ...gameView(game), ownDeck: own.deck_snapshot, ownMulligans: own.mulligans })
    }
    all['manifest.json'] = strToU8(JSON.stringify(manifest))
    const summaryColumns = ['gameId', 'matchId', 'gameNumber', 'status', 'winner', 'startPlayer', 'turns', 'ownMulligans']
    const cell = value => {
      const raw = String(value ?? '')
      const escaped = (/^[=+\-@\t\r]/.test(raw) ? "'" + raw : raw).replaceAll('"', '""')
      return '"' + escaped + '"'
    }
    const lines = [summaryColumns.join(','), ...manifest.games.map(game => summaryColumns.map(key => cell(game[key])).join(','))]
    all['summary.csv'] = strToU8(lines.join('\n') + '\n')
    return zipSync(all, { level: 4 })
  }

  return { archiveGames, recordEndCauses, matchList, replayPage, evaluation, exportReplays, authorizeExport, statistics, performance,
    reviewGame, reviewGames, reviewOwnDeckPair, streamTournamentRecords: game => streamReplayRecords(store, game),
    streamReviewArchive: game => streamReplayRecords(store, game), readReviewArchive: game => rawEvents(store, game) }
}
