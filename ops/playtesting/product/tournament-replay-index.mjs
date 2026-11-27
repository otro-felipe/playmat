import { randomUUID } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isUuid, ProductError } from './decks.mjs'
import { lineText } from './line-explanations.mjs'

export function hasTournamentReplayFrame(record) {
  return record.view?.players?.length === 2
}

/** Index only the viewer projection, never the raw archive. An unlinked file lives
 * until its final reader closes it, including across cache evictions and process exits. */
async function buildIndex(records, game, project) {
  const path = join(tmpdir(), 'playmat-replay-' + randomUUID())
  const file = await open(path, 'wx+', 0o600)
  try {
    await unlink(path)
    const frames = [],
      lines = [],
      seen = new Set()
    let lastBoard = null, lastPublicEvent = null, terminalEvent = false, cause = null
    let offset = 0
    async function append(value) {
      const bytes = Buffer.from(JSON.stringify(value))
      const entry = { offset, length: bytes.length }
      await file.writeFile(bytes)
      offset += bytes.length
      return entry
    }
    async function load(entry) {
      const bytes = Buffer.allocUnsafe(entry.length)
      let read = 0
      while (read < bytes.length) {
        const { bytesRead } = await file.read(bytes, read, bytes.length - read, entry.offset + read)
        if (!bytesRead) throw new ProductError(503, 'Replay frame is unavailable')
        read += bytesRead
      }
      return JSON.parse(bytes.toString('utf8'))
    }
    for await (const record of records) {
      const timing = Number.isFinite(record.t) && record.t >= 0 ? {elapsedMs:record.t} : {}
      if (record.kind === 'spectatorEnd') lastPublicEvent = {
        kind:record.terminal === true ? 'game_end' : 'recording_closed', ...timing,
      }
      if (record.kind === 'rollback') lastPublicEvent = {kind:'rollback', ...timing}
      if (['GAME','STATUS'].includes(record.log?.messageType)) lastPublicEvent = {kind:'game_log', ...timing}
      // Legacy spectatorEnd also fires on abandonment. It does not prove that the game ended.
      if (record.kind === 'spectatorEnd' && record.terminal === true) {
        terminalEvent = true
        cause = ['inactivity','player_clock','round_clock','concession','disconnect'].includes(record.cause)
          ? record.cause : null
      }
      const note = record.kind === 'line' && lineText(record)
      if (
        note &&
        isUuid(record.actorPlayerId) &&
        typeof record.commandId === 'string' &&
        record.commandId.length > 0 &&
        record.commandId.length <= 120
      ) {
        const lineId = game.id + ':' + record.actorPlayerId + ':' + record.commandId
        if (!seen.has(lineId)) {
          lastPublicEvent = {kind:'public_line', ...timing}
          seen.add(lineId)
          lines.push(
            await append({
              lineId,
              playerId: record.actorPlayerId,
              ...note,
              turn: record.turn,
              at: record.at ?? Number(game.started_at) + record.t,
            }),
          )
        }
      }
      if (!hasTournamentReplayFrame(record)) continue
      const projection = project(record, frames.length)
      lastBoard = {frame:frames.length, status:projection.status ?? 'playing'}
      lastPublicEvent = {kind:'board', ...timing}
      if (Number.isSafeInteger(projection.view?.turn)) lastBoard.turn = projection.view.turn
      if (projection.view?.step) lastBoard.step = projection.view.step
      const board = await append(projection)
      frames.push({ ...board, lineCount: lines.length })
    }
    if (frames.length) frames.at(-1).lineCount = lines.length
    return {
      summary: {frameCount:frames.length, lastBoard, lastPublicEvent, terminalEvent, cause},
      async frame(number) {
        const frame = frames[number]
        if (!frame) throw new ProductError(404, 'This tournament broadcast is unavailable')
        const recent = lines.slice(Math.max(0, frame.lineCount - 100), frame.lineCount)
        const [board, notes] = await Promise.all([load(frame), Promise.all(recent.map(load))])
        return { board, lines: notes }
      },
      close: () => file.close(),
    }
  } catch (error) {
    await file.close()
    throw error
  }
}

/** A bounded number of readers may build indexes. Identical concurrent requests
 * share a build; a viewer seeking while an entry is evicted retains its file. */
export function tournamentReplayIndexes(archive) {
  const entries = new Map(),
    summaries = new Map(),
    waiters = []
  let builders = 0,
    reclaiming
  async function releaseIdle(keep) {
    const closing = []
    for (const [key, entry] of entries) {
      if (entries.size <= keep) break
      if (entry.users || !entry.index) continue
      entries.delete(key)
      closing.push(entry.index.close())
    }
    await Promise.all(closing)
    return closing.length > 0
  }

  async function build(game, project) {
    if (builders >= 2) {
      if (waiters.length >= 32) throw new ProductError(503, 'Replay storage is busy. Try again shortly.')
      await new Promise((resolve) => waiters.push(resolve))
    } else {
      builders++
    }
    try {
      const attempt = () => buildIndex(archive.streamTournamentRecords(game), game, project)
      try {
        return await attempt()
      } catch (error) {
        if (error.code !== 'ENOSPC') throw error
        // Unlinked temp files return their blocks on close. Share reclamation
        // between builders, then reopen the archive from the start exactly once.
        reclaiming ??= releaseIdle(0).finally(() => {
          reclaiming = null
        })
        if (!(await reclaiming)) throw error
        return await attempt()
      }
    } finally {
      if (waiters.length) waiters.shift()()
      else builders--
    }
  }
  async function read(game, project, indexOnly, number) {
    const key = game.id + '/' + game.checksum
    if (indexOnly && summaries.has(key)) return summaries.get(key)
    let entry = entries.get(key)
    if (!entry) {
      entry = { users: 0 }
      entry.pending = build(game, project)
        .then((index) => {
          entry.index = index
          if (summaries.size >= 128) summaries.delete(summaries.keys().next().value)
          summaries.set(key, index.summary)
          return index
        })
        .catch((error) => {
          if (entries.get(key) === entry) entries.delete(key)
          throw error
        })
    }
    entries.delete(key)
    entries.set(key, entry)
    entry.users++
    try {
      const index = await entry.pending
      return indexOnly ? index.summary : await index.frame(number)
    } finally {
      entry.users--
      // Retain a full eight-player round for simultaneous spectators.
      await releaseIdle(4)
    }
  }
  async function close() {
    await Promise.all(
      [...entries.values()].map(async (entry) => {
        const index = await entry.pending.catch(() => null)
        await index?.close()
      }),
    )
    entries.clear()
    summaries.clear()
  }
  return { read, close }
}
