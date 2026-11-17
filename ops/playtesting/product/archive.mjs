import { createHash } from 'node:crypto'
import { readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { constants, gunzip, gzip } from 'node:zlib'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { strToU8, zipSync } from 'fflate'
import { isUuid, normalize, normalizeFormat, ProductError, transaction } from './decks.mjs'
import { viewerNames } from './identity.mjs'

const unzip = promisify(gunzip)
const compress = promisify(gzip)
const compressedLimit = 24 * 1024 * 1024
const decompressedLimit = 96 * 1024 * 1024
const exportLimit = 32 * 1024 * 1024
const digest = body => createHash('sha256').update(body).digest('hex')
const maxEntries = 10
const standardLogTypes = new Set(['GAME', 'STATUS'])

export function s3Store({ bucket, endpoint, region, forcePathStyle = false }) {
  if (!bucket || !region) throw new Error('Replay archive bucket and region are required')
  const s3 = new S3Client({ region, endpoint, forcePathStyle })
  return {
    async put(key, bytes, sha256) {
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: bytes, ContentType: 'application/x-ndjson',
          ContentEncoding: 'gzip', Metadata: { sha256 }, IfNoneMatch: '*',
        }), { abortSignal: AbortSignal.timeout(20_000) })
      } catch (error) {
        if (error.$metadata?.httpStatusCode !== 412) throw error
      }
    },
    async get(key) {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(20_000) })
      if (!result.Body || !(result.ContentLength <= compressedLimit)) throw new Error('Replay object is unavailable')
      return Buffer.from(await result.Body.transformToByteArray())
    },
  }
}

function fromLocal(store) {
  return store instanceof Map ? { put: async (key, body) => store.set(key, body), get: async key => store.get(key) } : store
}

function replayMetadata(raw, gameId) {
  if (raw.gameId !== gameId || !Array.isArray(raw.players) || raw.players.length < 1 || !Number.isSafeInteger(raw.startedAt)) {
    throw new Error('Invalid replay metadata')
  }
  return {
    gameId, matchId: isUuid(raw.matchId) ? raw.matchId : isUuid(raw.tableId) ? raw.tableId : gameId,
    tableId: isUuid(raw.tableId) ? raw.tableId : gameId, tableName: raw.tableName ?? '',
    format: normalizeFormat(raw.deckType), winsNeeded: raw.winsNeeded ?? null,
    gameNumber: Number.isSafeInteger(raw.gameNumber) ? raw.gameNumber : 1,
    startedAt: raw.startedAt, endedAt: raw.endedAt || null,
    result: raw.result ?? null, winner: raw.winner ?? null, startPlayer: raw.startPlayer ?? null,
    turns: raw.turns ?? null, events: raw.events ?? 0, truncated: Boolean(raw.truncated),
    players: raw.players.filter(p => typeof p.name === 'string').map(p => ({
      name: p.name, human: p.human === true, deck: p.deck ?? null, mulligans: p.mulligans ?? null,
    })),
  }
}

async function recordMetadata(pool, info, status) {
  await transaction(pool, async db => {
    await db.query(
      'INSERT INTO matches(id,table_id,name,format,wins_needed,started_at,status) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET started_at=LEAST(matches.started_at,EXCLUDED.started_at), status=CASE WHEN matches.status = \'completed\' THEN matches.status ELSE EXCLUDED.status END',
      [info.matchId, info.tableId, info.tableName, info.format, info.winsNeeded, info.startedAt, status === 'interrupted' ? 'interrupted' : 'active'],
    )
    await db.query(
      'INSERT INTO games(id,match_id,game_number,started_at,ended_at,result,winner,start_player,turns,events,status,archive_state,truncated) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET ended_at=EXCLUDED.ended_at,result=EXCLUDED.result,winner=EXCLUDED.winner,start_player=EXCLUDED.start_player,turns=EXCLUDED.turns,events=EXCLUDED.events,status=EXCLUDED.status,truncated=EXCLUDED.truncated WHERE games.status IN (\'active\',\'interrupted\') OR EXCLUDED.status=\'completed\'',
      [info.gameId, info.matchId, info.gameNumber, info.startedAt, info.endedAt, info.result, info.winner, info.startPlayer,
        info.turns, info.events, status, status === 'interrupted' || info.truncated ? 'partial' : 'pending', info.truncated],
    )
    for (const player of info.players) {
      await db.query(
        'INSERT INTO game_players(game_id,engine_key,engine_name,human,deck_snapshot,mulligans) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(game_id,engine_key) DO UPDATE SET mulligans=COALESCE(EXCLUDED.mulligans,game_players.mulligans),deck_snapshot=COALESCE(game_players.deck_snapshot,EXCLUDED.deck_snapshot)',
        [info.gameId, normalize(player.name), player.name, player.human, player.deck, player.mulligans],
      )
    }
  })
}

function projectReplayEvent(event, viewer) {
  if (event.log && standardLogTypes.has(event.log.messageType)) return { t: event.t, log: event.log }
  if (event.kind === 'rollback' && Number.isInteger(event.turn)) return { t: event.t, kind: 'rollback', turn: event.turn }
  if (!event.view || typeof event.view !== 'object') return null
  const view = pick(event.view, [
    'activePlayerId', 'activePlayerName', 'attackOption', 'bufferTime', 'combat', 'companion', 'events',
    'exiles', 'gameCycle', 'phase', 'priorityPlayerName', 'priorityTime', 'rangeOfInfluence',
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

async function projectedEvents(store, game, viewer) {
  if (!game.object_key) throw new ProductError(409, 'Replay is still being archived')
  const body = await store.get(game.object_key)
  if (!body || body.length > compressedLimit || digest(body) !== game.checksum) throw new ProductError(503, 'Replay cannot be verified')
  const plain = await unzip(body, { maxOutputLength: decompressedLimit })
  return plain.toString('utf8').split('\n').filter(Boolean).map(line => projectReplayEvent(JSON.parse(line), viewer)).filter(Boolean)
}

function gameView(row) {
  return {
    gameId: row.id, matchId: row.match_id, tableId: row.table_id, tableName: row.name,
    deckType: row.format ? 'Constructed - ' + row.format : undefined, gameNumber: row.game_number,
    startedAt: Number(row.started_at), endedAt: row.ended_at === null ? 0 : Number(row.ended_at),
    result: row.result, winner: row.winner, startPlayer: row.start_player, turns: row.turns,
    events: row.events, archiveState: row.archive_state, status: row.status,
    truncated: row.truncated, players: row.players, replayAvailable: Boolean(row.object_key),
    ownMulligans: row.own_mulligans,
  }
}

const selectGame = `
  SELECT g.*, m.table_id, m.name, m.format,
    (SELECT json_agg(json_build_object('name',p.engine_name,'human',p.human) ORDER BY p.engine_name)
       FROM game_players p WHERE p.game_id=g.id) AS players,
    (SELECT p.engine_key FROM game_players p WHERE p.game_id=g.id AND p.engine_key=ANY($1::text[])
       ORDER BY array_position($1::text[],p.engine_key) LIMIT 1) AS viewer,
    (SELECT p.mulligans FROM game_players p WHERE p.game_id=g.id AND p.engine_key=ANY($1::text[])
       ORDER BY array_position($1::text[],p.engine_key) LIMIT 1) AS own_mulligans
  FROM games g JOIN matches m ON m.id=g.match_id`

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

export function createArchive(pool, stage, backend) {
  const store = fromLocal(backend)
  let activeScan

  async function scan({ markInterrupted = false } = {}) {
    let files
    try {
      files = await readdir(stage)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    const knownFiles = new Set(files)
    for (const file of files) {
      const match = /^([\da-f-]+)(\.active|\.interrupted|\.match)?\.json$/i.exec(file)
      if (!match || !isUuid(match[1])) continue
      const [, id, variant] = match
      try {
        const raw = JSON.parse(await readFile(join(stage, file), 'utf8'))
        if (variant === '.match') {
          if (raw.matchId === id && Number.isSafeInteger(raw.endedAt)) {
            const saved = await pool.query('UPDATE matches SET status=\'completed\', ended_at=$2, winner=$3 WHERE id=$1', [id, raw.endedAt, raw.winner ?? null])
            if (saved.rowCount) await unlink(join(stage, file))
          }
          continue
        }
        if (raw.batchOwner || (variant === '.active' && knownFiles.has(id + '.json'))) continue
        const info = replayMetadata(raw, id)
        if (variant === '.active') {
          if (markInterrupted) {
            await rename(join(stage, file), join(stage, id + '.interrupted.json'))
            await recordMetadata(pool, info, 'interrupted')
          } else {
            await recordMetadata(pool, info, 'active')
          }
          continue
        }
        if (markInterrupted) continue
        const interrupted = variant === '.interrupted'
        const eventPath = join(stage, id + '.ndjson.gz' + (interrupted ? '.part' : ''))
        await recordMetadata(pool, info, interrupted ? 'interrupted' : 'completed')
        const previous = (await pool.query('SELECT checksum FROM games WHERE id=$1', [id])).rows[0]
        if (previous?.checksum) {
          await removeStaging(join(stage, file), eventPath)
          continue
        }
        if ((await stat(eventPath)).size > compressedLimit) {
          await pool.query('UPDATE games SET archive_state=\'partial\', truncated=TRUE WHERE id=$1', [id])
          continue
        }
        let bytes = await readFile(eventPath)
        if (interrupted) {
          bytes = await recoverInterrupted(bytes)
          if (!bytes) {
            await removeStaging(join(stage, file), eventPath)
            continue
          }
        }
        const hash = digest(bytes)
        const key = ['replays', 'v1', id, hash + '.ndjson.gz'].join('/')
        await store.put(key, bytes, hash)
        const uploaded = await store.get(key)
        if (!uploaded || digest(uploaded) !== hash) throw new Error('Archive verification failed')
        await pool.query('UPDATE games SET archive_state=$2, checksum=$3, object_key=$4 WHERE id=$1 AND checksum IS NULL', [
          id, info.truncated || interrupted ? 'partial' : 'ready', hash, key,
        ])
        await removeStaging(join(stage, file), eventPath)
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn('Playmat replay archive retry scheduled', { gameId: id })
      }
    }
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

  async function authorizedGame(actor, id) {
    if (!isUuid(id)) throw new ProductError(404, 'Replay not found')
    const { rows: [game] } = await pool.query(
      `${selectGame} WHERE g.id=$2 AND EXISTS(SELECT 1 FROM game_players p WHERE p.game_id=g.id AND p.engine_key=ANY($1::text[]))`,
      [viewerNames(actor), id],
    )
    if (!game) throw new ProductError(404, 'Replay not found')
    return game
  }

  async function matchList(actor, opts = {}) {
    const [older, earlierMatch] = parseCursor(opts.cursor)
    const format = opts.format ? normalizeFormat(opts.format) : null
    if (opts.format && !format) throw new ProductError(400, 'Unsupported format')
    const limit = Math.max(1, Math.min(100, Number.parseInt(opts.limit ?? '25', 10) || 25))
    const matchId = opts.id ?? null
    const { rows } = await pool.query(
      `SELECT m.* FROM matches m
       WHERE ($2::text IS NULL OR m.format=$2)
         AND ($3::bigint IS NULL OR (m.started_at,m.id)<($3,$4::uuid))
         AND ($6::uuid IS NULL OR m.id=$6)
         AND EXISTS(SELECT 1 FROM games g JOIN game_players p ON p.game_id=g.id WHERE g.match_id=m.id AND p.engine_key=ANY($1::text[]))
       ORDER BY m.started_at DESC,m.id DESC LIMIT $5`,
      [viewerNames(actor), format, older, earlierMatch, limit + 1, matchId],
    )
    const page = rows.slice(0, limit)
    const { rows: games } = await pool.query(
      `${selectGame} WHERE g.match_id=ANY($2::uuid[]) AND EXISTS(SELECT 1 FROM game_players p WHERE p.game_id=g.id AND p.engine_key=ANY($1::text[]))
       ORDER BY g.game_number,g.id`,
      [viewerNames(actor), page.map(m => m.id)],
    )
    return {
      matches: page.map(m => ({
        id: m.id, tableId: m.table_id, name: m.name, format: m.format, status: m.status, winner: m.winner,
        startedAt: Number(m.started_at), endedAt: m.ended_at ? Number(m.ended_at) : null,
        games: games.filter(g => g.match_id === m.id).map(gameView),
      })),
      cursor: rows.length > limit ? cursorFrom(page.at(-1)) : null,
    }
  }

  async function replayPage(actor, id, start, count) {
    const game = await authorizedGame(actor, id)
    const events = await projectedEvents(store, game, game.viewer)
    const from = Math.min(events.length, Math.max(0, Number.parseInt(start ?? '0', 10) || 0))
    const take = Math.max(1, Math.min(200, Number.parseInt(count ?? '100', 10) || 100))
    return { info: gameView(game), total: events.length, start: from, events: events.slice(from, from + take) }
  }

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

  return { archiveGames, matchList, replayPage, exportReplays, authorizeExport }
}
